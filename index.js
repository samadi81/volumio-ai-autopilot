'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const path = require('path');

const History = require('./lib/history');
const QueueMonitor = require('./lib/queue-monitor');
const Presets = require('./lib/presets');
const Feedback = require('./lib/feedback');
const HttpApi = require('./lib/http-api');
const Recommenders = {
  llm:     require('./recommenders/llm'),
  lastfm:  require('./recommenders/lastfm'),
  spotify: require('./recommenders/spotify'),
  local:   require('./recommenders/local')
};

module.exports = AiAutopilot;

function AiAutopilot(context) {
  const self = this;
  self.context = context;
  self.commandRouter = context.coreCommand;
  self.logger = context.logger;
  self.configManager = context.configManager;
}

// ---------- Lifecycle ----------

AiAutopilot.prototype.onVolumioStart = function () {
  const self = this;
  const configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
  return libQ.resolve();
};

AiAutopilot.prototype.onStart = function () {
  const self = this;
  const defer = libQ.defer();

  try {
    self.dataDir = path.join('/data/plugins/music_service/ai_autopilot');
    fs.ensureDirSync(self.dataDir);

    self.history = new History({
      filePath: path.join(self.dataDir, 'history.json'),
      windowSize: self.config.get('history_window', 20),
      logger: self.logger
    });
    self.history.load();

    self.feedback = new Feedback({
      filePath: path.join(self.dataDir, 'feedback.json'),
      logger: self.logger
    });
    self.feedback.load();

    self.monitor = new QueueMonitor({
      commandRouter: self.commandRouter,
      logger: self.logger,
      verbose: self.config.get('verbose_log', false),
      onTrackPlayed: (track) => self.handleTrackPlayed(track),
      onTrackSkipped: (track) => self.handleTrackSkipped(track),
      onTrigger: () => self.handleAutoTrigger()
    });

    self.applyTriggerConfig();
    self.monitor.start();

    // HTTP API for one-tap like/dislike from phone/browser
    self.httpApi = new HttpApi({
      plugin: self,
      port: Number(self.config.get('http_api_port', 3001)) || 0,
      logger: self.logger
    });
    self.httpApi.start();

    // One-time migration: if user had a legacy llm_api_key set,
    // copy it into the current provider's slot (only if that slot is empty).
    try {
      const legacy = self.config.get('llm_api_key', '') || '';
      const provider = self.config.get('llm_provider', 'anthropic');
      if (legacy && provider && provider !== 'ollama') {
        const slotKey = 'llm_api_key_' + provider;
        const slotVal = self.config.get(slotKey, '') || '';
        if (!slotVal) {
          self.config.set(slotKey, legacy);
          self.logger.info('[ai_autopilot] migrated legacy llm_api_key -> ' + slotKey);
        }
      }
    } catch (e) {
      self.logger.error('[ai_autopilot] key migration error: ' + e.message);
    }

    // Always log the installed music_service plugin names at startup.
    // This is the #1 thing you need to know to configure searchSource aliases.
    try {
      const names = self.commandRouter.pluginManager.getPluginNames('music_service') || [];
      self.logger.info('[ai_autopilot] installed music_service plugins: ' + JSON.stringify(names));
    } catch (e) {
      self.logger.info('[ai_autopilot] could not list plugins: ' + e.message);
    }

    self.log('AI Autopilot started');
    defer.resolve();
  } catch (err) {
    self.logger.error('[ai_autopilot] onStart failed: ' + err.stack);
    defer.reject(err);
  }

  return defer.promise;
};

AiAutopilot.prototype.onStop = function () {
  const self = this;
  try {
    if (self.monitor) self.monitor.stop();
    if (self.history) self.history.flush();
    if (self.httpApi) self.httpApi.stop();
  } catch (e) {
    self.logger.error('[ai_autopilot] onStop error: ' + e.message);
  }
  return libQ.resolve();
};

AiAutopilot.prototype.onRestart = function () {
  return libQ.resolve();
};

AiAutopilot.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

// ---------- UI Config ----------

AiAutopilot.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();
  const langCode = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + langCode + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  )
    .then((uiconf) => {
      const setField = (sectionIdx, fieldId, value) => {
        const section = uiconf.sections[sectionIdx];
        if (!section) return;
        const field = section.content.find((c) => c.id === fieldId);
        if (!field) return;
        if (field.element === 'select') {
          const match = (field.options || []).find((o) => o.value === value);
          field.value = match || { value, label: String(value) };
        } else {
          field.value = value;
        }
      };

      // section 0 - general
      setField(0, 'enabled', self.config.get('enabled', true));
      setField(0, 'source', self.config.get('source', 'auto'));
      setField(0, 'trigger_mode', self.config.get('trigger_mode', 'keep_ahead'));
      setField(0, 'keep_ahead_count', self.config.get('keep_ahead_count', 3));
      setField(0, 'cooldown_sec', self.config.get('cooldown_sec', 5));
      setField(0, 'http_api_port', self.config.get('http_api_port', 3001));
      setField(0, 'history_window', self.config.get('history_window', 20));
      setField(0, 'avoid_same_album_window', self.config.get('avoid_same_album_window', 10));
      setField(0, 'avoid_same_artist_window', self.config.get('avoid_same_artist_window', 0));
      setField(0, 'feedback_use_skip', self.config.get('feedback_use_skip', false));
      setField(0, 'verbose_log', self.config.get('verbose_log', false));

      // section 1 - recommender
      setField(1, 'recommender', self.config.get('recommender', 'llm'));
      setField(1, 'llm_provider', self.config.get('llm_provider', 'anthropic'));
      // per-provider model dropdowns
      const providers = [
        'anthropic', 'openai', 'google', 'groq', 'deepseek', 'xai',
        'mistral', 'openrouter', 'perplexity', 'together', 'ollama'
      ];
      providers.forEach((p) => {
        setField(1, 'llm_model_' + p, self.config.get('llm_model_' + p, ''));
      });
      // per-provider API key fields (excluding ollama which needs no key)
      const providersWithKey = providers.filter((p) => p !== 'ollama').concat(['custom']);
      providersWithKey.forEach((p) => {
        setField(1, 'llm_api_key_' + p, self.config.get('llm_api_key_' + p, ''));
      });
      setField(1, 'llm_model_custom', self.config.get('llm_model_custom', ''));
      setField(1, 'llm_base_url', self.config.get('llm_base_url', ''));
      setField(1, 'llm_hints', self.config.get('llm_hints', ''));
      setField(1, 'llm_system_prompt', self.config.get('llm_system_prompt', ''));
      setField(1, 'energy_min', self.config.get('energy_min', 0));
      setField(1, 'energy_max', self.config.get('energy_max', 10));

      // Inject preset options dynamically
      const promptSection = uiconf.sections[1];
      const promptField = promptSection && promptSection.content.find((c) => c.id === 'prompt_preset_selected');
      if (promptField) {
        promptField.options = Presets.PROMPTS.map((p) => ({ value: p.id, label: p.name }));
        const saved = self.config.get('prompt_preset_selected', 'default');
        const match = promptField.options.find((o) => o.value === saved) || promptField.options[0];
        promptField.value = match;
      }
      // Per-parent sub-preset dropdowns
      Presets.PROMPTS.forEach((parent) => {
        const subField = promptSection && promptSection.content.find((c) => c.id === 'prompt_sub_' + parent.id);
        if (!subField) return;
        const opts = [{ value: '', label: '(parent default)' }]
          .concat((parent.subs || []).map((s) => ({ value: s.id, label: s.name })));
        subField.options = opts;
        const savedSub = self.config.get('prompt_sub_' + parent.id, '');
        const match = opts.find((o) => o.value === savedSub) || opts[0];
        subField.value = match;
      });
      const hintField = promptSection && promptSection.content.find((c) => c.id === 'hint_preset_selected');
      if (hintField) {
        hintField.options = Presets.HINTS.map((h) => ({ value: h.id, label: h.name }));
        const saved = self.config.get('hint_preset_selected', 'none');
        const match = hintField.options.find((o) => o.value === saved) || hintField.options[0];
        hintField.value = match;
      }

      // Dynamically populate the "Open in browser" buttons' URLs with
      // data: URLs containing the current prompt / hints text. The user can
      // view or save-as in a new tab without SSH.
      const encodeDataUrl = (text) =>
        'data:text/plain;charset=utf-8,' + encodeURIComponent(text || '(empty — use a preset above)');
      const openPromptBtn = promptSection && promptSection.content.find((c) => c.id === 'open_prompt_browser');
      if (openPromptBtn && openPromptBtn.onClick) {
        openPromptBtn.onClick.url = encodeDataUrl(self.config.get('llm_system_prompt', ''));
      }
      const openHintsBtn = promptSection && promptSection.content.find((c) => c.id === 'open_hints_browser');
      if (openHintsBtn && openHintsBtn.onClick) {
        openHintsBtn.onClick.url = encodeDataUrl(self.config.get('llm_hints', ''));
      }

      // Remote control button — fill in LAN IP + port dynamically.
      const actionsSection = uiconf.sections[2];
      const openRemoteBtn = actionsSection && actionsSection.content &&
        actionsSection.content.find((c) => c.id === 'open_remote');
      if (openRemoteBtn && openRemoteBtn.onClick) {
        let host = null;
        try {
          const os = require('os');
          const ifs = os.networkInterfaces();
          Object.keys(ifs).forEach((name) => {
            (ifs[name] || []).forEach((iface) => {
              if (!iface.internal && iface.family === 'IPv4' && !host) host = iface.address;
            });
          });
        } catch (e) {}
        const port = Number(self.config.get('http_api_port', 3001)) || 3001;
        openRemoteBtn.onClick.url = 'http://' + (host || 'volumio.local') + ':' + port + '/';
      }
      setField(1, 'lastfm_api_key', self.config.get('lastfm_api_key', ''));
      setField(1, 'lastfm_user', self.config.get('lastfm_user', ''));
      setField(1, 'spotify_client_id', self.config.get('spotify_client_id', ''));
      setField(1, 'spotify_client_secret', self.config.get('spotify_client_secret', ''));
      setField(1, 'spotify_refresh_token', self.config.get('spotify_refresh_token', ''));

      defer.resolve(uiconf);
    })
    .fail((err) => {
      self.logger.error('[ai_autopilot] getUIConfig error: ' + err);
      defer.reject(err);
    });

  return defer.promise;
};

AiAutopilot.prototype.saveGeneralSettings = function (data) {
  const self = this;
  ['enabled', 'keep_ahead_count', 'cooldown_sec', 'http_api_port', 'history_window',
   'avoid_same_album_window', 'avoid_same_artist_window',
   'verbose_log', 'feedback_use_skip'].forEach((k) => {
    if (data[k] !== undefined) self.config.set(k, data[k]);
  });
  if (data.source) self.config.set('source', valueOf(data.source));
  if (data.trigger_mode) self.config.set('trigger_mode', valueOf(data.trigger_mode));

  self.applyTriggerConfig();
  self.history && self.history.setWindowSize(self.config.get('history_window', 20));

  // restart HTTP API if the port changed
  if (self.httpApi) {
    const newPort = Number(self.config.get('http_api_port', 3001)) || 0;
    if (newPort !== self.httpApi.port) {
      self.httpApi.stop();
      self.httpApi.port = newPort;
      self.httpApi.start();
    }
  }

  self.commandRouter.pushToastMessage('success', 'AI Autopilot', self.t('SETTINGS_SAVED'));
  return libQ.resolve({});
};

AiAutopilot.prototype.saveRecommenderSettings = function (data) {
  const self = this;
  if (data.recommender) self.config.set('recommender', valueOf(data.recommender));
  if (data.llm_provider) self.config.set('llm_provider', valueOf(data.llm_provider));

  const providersWithKey = [
    'anthropic', 'openai', 'google', 'groq', 'deepseek', 'xai',
    'mistral', 'openrouter', 'perplexity', 'together', 'custom'
  ];
  const providersAll = providersWithKey.concat(['ollama']);

  // Persist per-provider API keys. Only save if the user submitted a non-empty value
  // (this lets the "hidden" providers keep their keys intact when the user saves
  // a different provider's form).
  providersWithKey.forEach((p) => {
    const key = 'llm_api_key_' + p;
    if (data[key] !== undefined && data[key] !== '') self.config.set(key, data[key]);
  });

  // Persist per-provider model dropdowns.
  providersAll.forEach((p) => {
    const key = 'llm_model_' + p;
    if (data[key] !== undefined) self.config.set(key, valueOf(data[key]));
  });
  if (data.llm_model_custom !== undefined) self.config.set('llm_model_custom', data.llm_model_custom);

  // Resolve effective llm_model and llm_api_key based on current provider.
  const provider = self.config.get('llm_provider', 'anthropic');
  const customModel = (self.config.get('llm_model_custom', '') || '').trim();
  const preset = (self.config.get('llm_model_' + provider, '') || '').trim();
  self.config.set('llm_model', customModel || preset);
  self.config.set('llm_api_key', self.config.get('llm_api_key_' + provider, '') || '');

  [
    'llm_base_url',
    'llm_hints',
    'llm_system_prompt',
    'lastfm_api_key',
    'lastfm_user',
    'spotify_client_id',
    'spotify_client_secret',
    'spotify_refresh_token'
  ].forEach((k) => {
    if (data[k] !== undefined) self.config.set(k, data[k]);
  });
  if (data.prompt_preset_selected !== undefined) self.config.set('prompt_preset_selected', valueOf(data.prompt_preset_selected));
  if (data.hint_preset_selected !== undefined) self.config.set('hint_preset_selected', valueOf(data.hint_preset_selected));
  Presets.PROMPTS.forEach((parent) => {
    const key = 'prompt_sub_' + parent.id;
    if (data[key] !== undefined) self.config.set(key, valueOf(data[key]));
  });
  if (data.energy_min !== undefined) self.config.set('energy_min', Number(data.energy_min));
  if (data.energy_max !== undefined) self.config.set('energy_max', Number(data.energy_max));
  self.commandRouter.pushToastMessage('success', 'AI Autopilot', self.t('SETTINGS_SAVED'));
  return libQ.resolve({});
};

// ---------- Button actions ----------

AiAutopilot.prototype.triggerManual = function () {
  const self = this;
  self.commandRouter.pushToastMessage('info', 'AI Autopilot', self.t('MANUAL_TRIGGER_OK'));
  return self.pickAndQueue();
};

AiAutopilot.prototype.applyPromptPreset = function () {
  const self = this;
  const id = self.config.get('prompt_preset_selected', 'default');
  const parent = Presets.PROMPTS.find((p) => p.id === id);
  if (!parent) {
    self.commandRouter.pushToastMessage('error', 'AI Autopilot', 'Preset not found: ' + id);
    return libQ.resolve({});
  }
  const subId = self.config.get('prompt_sub_' + id, '');
  const sub = subId && parent.subs && parent.subs.find((s) => s.id === subId);
  const text = sub ? sub.text : parent.text;
  const label = parent.name + (sub ? ' → ' + sub.name : '');
  self.config.set('llm_system_prompt', text);
  self.logger.info('[ai_autopilot] applied prompt preset: ' + label);
  self.commandRouter.pushToastMessage('success', 'AI Autopilot',
    self.t('PRESET_LOADED') + ' (' + label + ')');
  return libQ.resolve({});
};

AiAutopilot.prototype.applyHintPreset = function () {
  const self = this;
  const id = self.config.get('hint_preset_selected', 'none');
  const preset = Presets.HINTS.find((h) => h.id === id);
  if (!preset) {
    self.commandRouter.pushToastMessage('error', 'AI Autopilot', 'Preset not found: ' + id);
    return libQ.resolve({});
  }
  self.config.set('llm_hints', preset.text);
  self.commandRouter.pushToastMessage('success', 'AI Autopilot', self.t('PRESET_LOADED'));
  return libQ.resolve({});
};

AiAutopilot.prototype.clearHistory = function () {
  const self = this;
  if (self.history) self.history.clear();
  self.commandRouter.pushToastMessage('success', 'AI Autopilot', self.t('HISTORY_CLEARED'));
  return libQ.resolve({});
};

AiAutopilot.prototype.exportPromptsToFile = function () {
  const self = this;
  try {
    const p = path.join(self.dataDir, 'system_prompt.txt');
    const h = path.join(self.dataDir, 'hints.txt');
    fs.writeFileSync(p, self.config.get('llm_system_prompt', '') || '', 'utf8');
    fs.writeFileSync(h, self.config.get('llm_hints', '') || '', 'utf8');
    const msg = self.t('EXPORT_OK').replace('{{path}}', self.dataDir);
    self.logger.info('[ai_autopilot] exported prompts to ' + p + ' and ' + h);
    self.commandRouter.pushToastMessage('success', 'AI Autopilot', msg);
  } catch (e) {
    self.logger.error('[ai_autopilot] exportPrompts error: ' + e.message);
    self.commandRouter.pushToastMessage('error', 'AI Autopilot', e.message);
  }
  return libQ.resolve({});
};

AiAutopilot.prototype.importPromptsFromFile = function () {
  const self = this;
  try {
    const p = path.join(self.dataDir, 'system_prompt.txt');
    const h = path.join(self.dataDir, 'hints.txt');
    if (!fs.existsSync(p) && !fs.existsSync(h)) {
      self.commandRouter.pushToastMessage('warning', 'AI Autopilot', self.t('IMPORT_MISSING'));
      return libQ.resolve({});
    }
    let pText = '', hText = '';
    if (fs.existsSync(p)) pText = fs.readFileSync(p, 'utf8');
    if (fs.existsSync(h)) hText = fs.readFileSync(h, 'utf8');
    self.config.set('llm_system_prompt', pText);
    self.config.set('llm_hints', hText);
    const msg = self.t('IMPORT_OK')
      .replace('{{p}}', String(pText.length))
      .replace('{{h}}', String(hText.length));
    self.logger.info('[ai_autopilot] imported prompts: system=' + pText.length + ' hints=' + hText.length);
    self.commandRouter.pushToastMessage('success', 'AI Autopilot', msg);
  } catch (e) {
    self.logger.error('[ai_autopilot] importPrompts error: ' + e.message);
    self.commandRouter.pushToastMessage('error', 'AI Autopilot', e.message);
  }
  return libQ.resolve({});
};

AiAutopilot.prototype._currentPlayingTrack = function () {
  const self = this;
  try {
    const s = self.commandRouter.volumioGetState();
    if (s && s.uri && s.title) {
      return { uri: s.uri, title: s.title, artist: s.artist, album: s.album, service: s.service };
    }
  } catch (e) {}
  return null;
};

AiAutopilot.prototype._recordFeedback = function (rating) {
  const self = this;
  const t = self._currentPlayingTrack();
  if (!t) {
    self.commandRouter.pushToastMessage('warning', 'AI Autopilot', self.t('FEEDBACK_NO_TRACK'));
    return libQ.resolve({});
  }
  self.feedback.record({
    uri: t.uri,
    artist: t.artist,
    title: t.title,
    rating: rating,
    source: 'button'
  });
  const label = (t.artist ? t.artist + ' — ' : '') + t.title;
  const key = rating === 'like' ? 'FEEDBACK_LIKED' : 'FEEDBACK_DISLIKED';
  self.commandRouter.pushToastMessage('success', 'AI Autopilot',
    self.t(key).replace('{{track}}', label));
  self.logger.info('[ai_autopilot] BUTTON feedback ' + rating + ': "' + label + '"');
  return libQ.resolve({});
};

AiAutopilot.prototype.showRemoteUrl = function () {
  const self = this;
  let host = null;
  // Try to discover the Volumio host's LAN IP from the OS.
  try {
    const os = require('os');
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((name) => {
      (ifs[name] || []).forEach((iface) => {
        if (!iface.internal && iface.family === 'IPv4' && !host) host = iface.address;
      });
    });
  } catch (e) {}
  const port = Number(self.config.get('http_api_port', 3001)) || 3001;
  const urlStr = 'http://' + (host || 'volumio.local') + ':' + port + '/';
  self.logger.info('[ai_autopilot] Remote URL: ' + urlStr);
  const msg = self.t('REMOTE_URL_TOAST').replace('{{url}}', urlStr);
  self.commandRouter.pushToastMessage('info', 'AI Autopilot', msg);
  return libQ.resolve({});
};

AiAutopilot.prototype.likeCurrent = function () {
  return this._recordFeedback('like');
};

AiAutopilot.prototype.dislikeCurrent = function () {
  return this._recordFeedback('dislike');
};

AiAutopilot.prototype.feedbackStatus = function () {
  const self = this;
  const snap = self.feedback.snapshot({ maxLikes: 20, maxDislikes: 20 });
  const likeNames = snap.likes.map((l) => (l.artist ? l.artist + ' — ' : '') + l.title);
  const disNames = snap.dislikes.map((d) =>
    (d.artist ? d.artist + ' — ' : '') + d.title + (d.source === 'skip' ? ' (skip)' : ''));
  self.logger.info('[ai_autopilot] feedback LIKES (' + snap.likes.length + '): ' + JSON.stringify(likeNames));
  self.logger.info('[ai_autopilot] feedback DISLIKES (' + snap.dislikes.length + '): ' + JSON.stringify(disNames));
  const msg = self.t('FEEDBACK_SUMMARY')
    .replace('{{likes}}', String(snap.likes.length))
    .replace('{{dislikes}}', String(snap.dislikes.length));
  self.commandRouter.pushToastMessage('info', 'AI Autopilot', msg);
  return libQ.resolve({});
};

AiAutopilot.prototype.clearFeedback = function () {
  const self = this;
  if (self.feedback) self.feedback.clear();
  self.commandRouter.pushToastMessage('success', 'AI Autopilot', self.t('FEEDBACK_CLEARED'));
  return libQ.resolve({});
};

AiAutopilot.prototype.listSources = function () {
  const self = this;
  const categories = ['music_service', 'user_interface', 'system_controller',
    'miscellanea', 'audio_interface'];
  try {
    categories.forEach((cat) => {
      let names = [];
      try {
        names = self.commandRouter.pluginManager.getPluginNames(cat) || [];
      } catch (e) {
        names = ['<error:' + e.message + '>'];
      }
      self.logger.info('[ai_autopilot] plugins[' + cat + '] = ' + JSON.stringify(names));
    });

    // Also try a generic search to see which services actually return hits.
    const testQueries = ['jazz', 'radiohead'];
    testQueries.forEach((q) => {
      try {
        const res = self.commandRouter.volumioSearch({ value: q });
        libQ.resolve(res).then((sections) => {
          if (!Array.isArray(sections)) return;
          const svcs = sections.map((s) => ({
            service: s.service,
            plugin_name: s.plugin_name,
            title: s.title,
            items: (s.items || []).length
          }));
          self.logger.info('[ai_autopilot] search("' + q + '") services = ' + JSON.stringify(svcs));
        }).fail((e) => self.logger.error('[ai_autopilot] search err: ' + e.message));
      } catch (e) {
        self.logger.error('[ai_autopilot] search threw: ' + e.message);
      }
    });
  } catch (e) {
    self.logger.error('[ai_autopilot] listSources error: ' + e.message);
  }
  self.commandRouter.pushToastMessage('info', 'AI Autopilot', self.t('SOURCES_LISTED'));
  return libQ.resolve({});
};

AiAutopilot.prototype.dryRun = function () {
  const self = this;
  const defer = libQ.defer();

  const recommenderName = self.config.get('recommender', 'llm');
  const source = self.config.get('source', 'tidal');
  self.logger.info('[ai_autopilot] DRY RUN begin: recommender=' + recommenderName +
    ' source=' + source + ' historySize=' + (self.history ? self.history.all().length : 0));

  const RecClass = Recommenders[recommenderName];
  if (!RecClass) {
    defer.reject(new Error('Unknown recommender: ' + recommenderName));
    return defer.promise;
  }

  const recommender = new RecClass({
    config: self.configSnapshot(),
    logger: self.logger,
    log: (m) => self.log(m)
  });

  const history = self.history.recent();
  const fb = self.feedback ? self.feedback.snapshot({ maxLikes: 15, maxDislikes: 15 }) : { likes: [], dislikes: [] };

  recommender.recommend(history, fb)
    .then((pick) => {
      if (!pick || !pick.title) {
        self.commandRouter.pushToastMessage('warning', 'AI Autopilot', self.t('NO_RECOMMENDATION'));
        defer.resolve({});
        return;
      }
      const query = pick.artist ? pick.artist + ' ' + pick.title : pick.title;
      return self.searchSourceDiagnostic(source, query).then((diag) => {
        const label = (pick.artist ? pick.artist + ' — ' : '') + pick.title;
        self.logger.info('[ai_autopilot] DRY RUN pick=' + label +
          ' source=' + source +
          ' matches=' + diag.matched.length +
          ' allServices=' + JSON.stringify(diag.allServices) +
          ' sampleMatches=' + JSON.stringify(diag.matched.slice(0, 3).map(m => ({ service: m.service, uri: m.uri }))));
        const msg = self.t('DRY_RUN_RESULT')
          .replace('{{pick}}', label)
          .replace('{{source}}', source)
          .replace('{{count}}', String(diag.matched.length))
          .replace('{{services}}', diag.allServices.join(',') || 'none');
        self.commandRouter.pushToastMessage('info', 'AI Autopilot', msg);
        defer.resolve({});
      });
    })
    .catch((err) => {
      self.logger.error('[ai_autopilot] dryRun error: ' + (err && err.stack ? err.stack : err));
      self.commandRouter.pushToastMessage('error', 'AI Autopilot', err.message || String(err));
      defer.reject(err);
    });

  return defer.promise;
};

// ---------- Core logic ----------

AiAutopilot.prototype.applyTriggerConfig = function () {
  const self = this;
  if (!self.monitor) return;
  self.monitor.setConfig({
    trigger_mode: self.config.get('trigger_mode', 'keep_ahead'),
    keep_ahead_count: self.config.get('keep_ahead_count', 3),
    enabled: self.config.get('enabled', true)
  });
  self.monitor.setCooldown(Number(self.config.get('cooldown_sec', 5)) * 1000);
  self.monitor.setVerbose(self.config.get('verbose_log', false));
};

AiAutopilot.prototype.handleTrackPlayed = function (track) {
  const self = this;
  if (!track || !track.title) return;
  self.history.push({
    title: track.title,
    artist: track.artist,
    album: track.album,
    service: track.service,
    uri: track.uri,
    at: Date.now()
  });
  self.log('Recorded history: ' + track.artist + ' — ' + track.title);
};

AiAutopilot.prototype.handleTrackSkipped = function (track) {
  const self = this;
  if (!track || !track.title) return;
  const useSkip = !!self.config.get('feedback_use_skip', false);
  if (!useSkip) {
    self.logger.info('[ai_autopilot] skip detected but feedback_use_skip=OFF; ignoring: "' +
      (track.artist || '?') + ' — ' + track.title + '"');
    return;
  }
  self.feedback.record({
    uri: track.uri,
    artist: track.artist,
    title: track.title,
    rating: 'dislike',
    source: 'skip'
  });
  self.logger.info('[ai_autopilot] SKIP feedback recorded: "' + (track.artist || '?') + ' — ' + track.title + '"');
};

AiAutopilot.prototype.handleAutoTrigger = function () {
  const self = this;
  if (!self.config.get('enabled', true)) return;
  return self.pickAndQueue().fail((err) => {
    self.logger.error('[ai_autopilot] auto trigger failed: ' + err.message);
  });
};

AiAutopilot.prototype.pickAndQueue = function () {
  const self = this;
  const defer = libQ.defer();
  const t0 = Date.now();

  const recommenderName = self.config.get('recommender', 'llm');
  const source = self.config.get('source', 'auto');
  const provider = self.config.get('llm_provider', 'anthropic');
  const historySize = self.history ? self.history.all().length : 0;
  self.logger.info('[ai_autopilot] PICK begin: recommender=' + recommenderName +
    ' llm_provider=' + provider + ' source=' + source + ' historySize=' + historySize);

  const RecClass = Recommenders[recommenderName];
  if (!RecClass) {
    defer.reject(new Error('Unknown recommender: ' + recommenderName));
    return defer.promise;
  }

  const recommender = new RecClass({
    config: self.configSnapshot(),
    logger: self.logger,
    log: (m) => self.log(m)
  });

  const history = self.history.recent();
  const fb = self.feedback ? self.feedback.snapshot({ maxLikes: 15, maxDislikes: 15 }) : { likes: [], dislikes: [] };
  self.logger.info('[ai_autopilot] PICK feedback ctx: likes=' + fb.likes.length + ' dislikes=' + fb.dislikes.length);

  recommender
    .recommend(history, fb)
    .then((pick) => {
      const recT = Date.now() - t0;
      if (!pick || !pick.title) {
        self.logger.info('[ai_autopilot] PICK: recommender returned nothing (' + recT + 'ms)');
        self.commandRouter.pushToastMessage('warning', 'AI Autopilot', self.t('NO_RECOMMENDATION'));
        defer.resolve({});
        return;
      }
      const label = (pick.artist ? pick.artist + ' — ' : '') + pick.title;
      self.logger.info('[ai_autopilot] PICK got "' + label + '" in ' + recT + 'ms; resolving on ' + source);
      return self.resolveAndQueue(pick).then(() => {
        self.logger.info('[ai_autopilot] QUEUED "' + label + '" (total ' + (Date.now() - t0) + 'ms)');
        self.commandRouter.pushToastMessage(
          'success',
          'AI Autopilot',
          self.t('TRACK_QUEUED').replace('{{track}}', label)
        );
        defer.resolve({});
      });
    })
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      self.logger.error('[ai_autopilot] PICK FAIL after ' + (Date.now() - t0) + 'ms: ' + (err && err.stack ? err.stack : err));
      self.commandRouter.pushToastMessage('error', 'AI Autopilot', msg);
      defer.reject(err);
    });

  return defer.promise;
};

// Resolve pick via the chosen source plugin and enqueue it.
AiAutopilot.prototype.resolveAndQueue = function (pick) {
  const self = this;
  const source = self.config.get('source', 'auto');
  const query = pick.artist ? pick.artist + ' ' + pick.title : pick.title;

  return self.searchSourceDiagnostic(source, query).then((diag) => {
    self.logger.info('[ai_autopilot] resolve: query="' + query + '" matches=' + diag.matched.length +
      ' services=[' + diag.allServices.join(',') + ']' +
      (diag.fallbackUsed ? ' (fallback used)' : ''));
    if (!diag.matched || diag.matched.length === 0) {
      throw new Error('No ' + source + ' tracks for "' + query + '". Services searched: ' +
        (diag.allServices.join(',') || 'none'));
    }

    // Filter out results that collide with recent albums/artists.
    const albumWin = Math.max(0, Number(self.config.get('avoid_same_album_window', 10)) || 0);
    const artistWin = Math.max(0, Number(self.config.get('avoid_same_artist_window', 0)) || 0);
    const histItems = self.history ? self.history.all() : [];
    const recentAlbums = new Set(
      albumWin > 0 ? histItems.slice(-albumWin).map((t) => (t.album || '').toLowerCase()).filter(Boolean) : []
    );
    const recentArtists = new Set(
      artistWin > 0 ? histItems.slice(-artistWin).map((t) => (t.artist || '').toLowerCase()).filter(Boolean) : []
    );

    const filtered = diag.matched.filter((m) => {
      const a = (m.album || '').toLowerCase();
      const ar = (m.artist || '').toLowerCase();
      if (a && recentAlbums.has(a)) return false;
      if (ar && recentArtists.has(ar)) return false;
      return true;
    });
    const chosen = filtered.length ? filtered : diag.matched; // if all filtered out, fall back
    if (filtered.length === 0 && (recentAlbums.size || recentArtists.size)) {
      self.logger.info('[ai_autopilot] all search results collided with recent album/artist; using first result anyway');
    } else if (filtered.length < diag.matched.length) {
      self.logger.info('[ai_autopilot] filtered ' + (diag.matched.length - filtered.length) +
        ' duplicate-album/artist results');
    }
    const item = chosen[0];
    self.logger.info('[ai_autopilot] adding to queue: service=' + item.service + ' uri=' + item.uri +
      ' album="' + (item.album || '') + '" artist="' + (item.artist || '') + '"');
    // addQueueItems returns a kew/native promise directly; do not wrap in nfcall.
    const p = self.commandRouter.addQueueItems([item]);
    return libQ.resolve(p)
      .then((res) => {
        try {
          self.logger.info('[ai_autopilot] addQueueItems returned: ' +
            (res === undefined ? 'undefined' : JSON.stringify(res).slice(0, 300)));
        } catch (e) {
          self.logger.info('[ai_autopilot] addQueueItems returned (unserializable)');
        }
        return res;
      })
      .fail((err) => {
        self.logger.error('[ai_autopilot] addQueueItems failed: ' + (err && err.message ? err.message : err));
        throw err;
      });
  });
};

// Search across installed plugins; filter by source service.
AiAutopilot.prototype.searchSource = function (source, query) {
  return this.searchSourceDiagnostic(source, query).then((d) => d.matched);
};

// Same search, but also returns all services seen (for diagnosis).
AiAutopilot.prototype.searchSourceDiagnostic = function (source, query) {
  const self = this;
  const defer = libQ.defer();

  const serviceAliases = {
    tidal: ['tidal', 'tidalapi', 'tidal_connect', 'tidal2'],
    qobuz: ['qobuz', 'volumio_qobuz', 'my_qobuz'],
    mpd:   ['mpd']
  };
  const wantAny = (source === 'auto');
  const want = new Set(serviceAliases[source] || [source]);

  self.logger.info('[ai_autopilot] searching query="' + query + '" source=' + source);

  // Try commandRouter.volumioSearch first; if empty, fall back to REST API.
  let results;
  try {
    results = self.commandRouter.volumioSearch({ value: query });
    self.logger.info('[ai_autopilot] volumioSearch returned type=' +
      (results === null ? 'null' : typeof results) +
      ' isArray=' + Array.isArray(results) +
      ' isPromise=' + (results && typeof results.then === 'function'));
  } catch (e) {
    self.logger.error('[ai_autopilot] volumioSearch threw: ' + e.message);
    results = null;
  }

  const toSections = (val) => {
    if (Array.isArray(val)) return val;
    if (val && Array.isArray(val.navigation)) return val.navigation.lists || [];
    if (val && Array.isArray(val.lists)) return val.lists;
    return null;
  };

  libQ.resolve(results)
    .then((raw) => {
      const sectionsFromPrimary = toSections(raw);
      self.logger.info('[ai_autopilot] primary search keys=' +
        (raw && typeof raw === 'object' ? JSON.stringify(Object.keys(raw).slice(0,10)) : 'n/a') +
        ' sections=' + (sectionsFromPrimary ? sectionsFromPrimary.length : 'null'));
      if (sectionsFromPrimary && sectionsFromPrimary.length > 0) return sectionsFromPrimary;
      // Fallback: REST API
      return self._restSearch(query);
    })
    .then((sections) => {
      const diag = { matched: [], allServices: [], fallbackUsed: false };
      if (!sections || !Array.isArray(sections)) {
        defer.resolve(diag);
        return;
      }
      const seen = new Set();
      const svcOfItem = (it, fallback) => {
        if (it && it.service) return String(it.service).toLowerCase();
        if (it && it.uri) {
          const m = String(it.uri).match(/^([a-z0-9_-]+):\/\//i);
          if (m) return m[1].toLowerCase();
        }
        return (fallback || '').toLowerCase();
      };
      sections.forEach((section) => {
        const secSvc = (section.service || section.plugin_name || '').toLowerCase();
        (section.items || []).forEach((it) => {
          const svc = svcOfItem(it, secSvc);
          if (svc && !seen.has(svc)) { seen.add(svc); diag.allServices.push(svc); }
          if (!wantAny && !want.has(svc)) return;
          if (!it.uri) return;
          if (it.type && !(it.type === 'song' || it.type === 'track')) return;
          diag.matched.push({
            service: svc,
            uri: it.uri,
            title: it.title,
            artist: it.artist,
            album: it.album,
            albumart: it.albumart,
            type: 'song'
          });
        });
      });
      if (diag.matched.length === 0 && !wantAny) {
        // fallback: accept any music_service result (but flag it)
        diag.fallbackUsed = true;
        sections.forEach((section) => {
          const secSvc = (section.service || '').toLowerCase();
          (section.items || []).forEach((it) => {
            const svc = svcOfItem(it, secSvc);
            if (!it.uri) return;
            if (it.type && !(it.type === 'song' || it.type === 'track')) return;
            diag.matched.push({
              service: svc,
              uri: it.uri,
              title: it.title,
              artist: it.artist,
              album: it.album,
              albumart: it.albumart,
              type: 'song'
            });
          });
        });
      }
      defer.resolve(diag);
    })
    .fail((err) => defer.reject(err));

  return defer.promise;
};

// Fallback search via Volumio's local REST API.
AiAutopilot.prototype._restSearch = function (query) {
  const self = this;
  const fetch = require('node-fetch');
  const url = 'http://localhost:3000/api/v1/search?query=' + encodeURIComponent(query);
  self.logger.info('[ai_autopilot] REST fallback -> ' + url);
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error('REST search status ' + res.status);
      return res.json();
    })
    .then((data) => {
      // Shape is usually { navigation: { lists: [ {title, availableListViews, items, plugin_name?, ...} ] } }
      let sections = [];
      if (data && data.navigation && Array.isArray(data.navigation.lists)) {
        sections = data.navigation.lists;
      } else if (Array.isArray(data)) {
        sections = data;
      }
      self.logger.info('[ai_autopilot] REST search sections=' + sections.length +
        ' shape=' + (Array.isArray(data) ? 'array' : (data && data.navigation ? 'navigation' : 'unknown')));
      return sections;
    })
    .catch((err) => {
      self.logger.error('[ai_autopilot] REST search failed: ' + err.message);
      return [];
    });
};

// ---------- Helpers ----------

AiAutopilot.prototype.configSnapshot = function () {
  const self = this;
  const provider = self.config.get('llm_provider', 'anthropic');

  // Prefer per-provider key; fall back to legacy unified llm_api_key.
  const providerKey = self.config.get('llm_api_key_' + provider, '') || '';
  const legacyKey = self.config.get('llm_api_key', '') || '';
  const effectiveKey = providerKey || legacyKey;

  // Same for model: per-provider dropdown wins, custom text overrides everything.
  const customModel = (self.config.get('llm_model_custom', '') || '').trim();
  const providerModel = (self.config.get('llm_model_' + provider, '') || '').trim();
  const legacyModel = (self.config.get('llm_model', '') || '').trim();
  const effectiveModel = customModel || providerModel || legacyModel;

  return {
    recommender: self.config.get('recommender', 'llm'),
    llm_provider: provider,
    llm_api_key: effectiveKey,
    llm_model: effectiveModel,
    llm_base_url: self.config.get('llm_base_url', ''),
    llm_hints: self.config.get('llm_hints', ''),
    llm_system_prompt: self.config.get('llm_system_prompt', ''),
    energy_min: Number(self.config.get('energy_min', 0)),
    energy_max: Number(self.config.get('energy_max', 10)),
    avoid_same_album_window: Number(self.config.get('avoid_same_album_window', 10)),
    avoid_same_artist_window: Number(self.config.get('avoid_same_artist_window', 0)),
    lastfm_api_key: self.config.get('lastfm_api_key', ''),
    lastfm_user: self.config.get('lastfm_user', ''),
    spotify_client_id: self.config.get('spotify_client_id', ''),
    spotify_client_secret: self.config.get('spotify_client_secret', ''),
    spotify_refresh_token: self.config.get('spotify_refresh_token', '')
  };
};

AiAutopilot.prototype.log = function (msg) {
  const verbose = this.config && this.config.get('verbose_log', false);
  if (verbose) this.logger.info('[ai_autopilot] ' + msg);
};

AiAutopilot.prototype.t = function (key) {
  const self = this;
  try {
    const lang = self.commandRouter.sharedVars.get('language_code');
    const strings = require('./i18n/strings_' + lang + '.json');
    if (strings && strings[key]) return strings[key];
  } catch (e) {}
  try {
    const en = require('./i18n/strings_en.json');
    if (en[key]) return en[key];
  } catch (e) {}
  return key;
};

function valueOf(v) {
  if (v && typeof v === 'object' && 'value' in v) return v.value;
  return v;
}
