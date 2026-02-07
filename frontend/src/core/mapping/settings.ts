import type { BackupIR } from '../ir/types';
import {
  asArray,
  asMap,
  asString,
  cloneAny,
  dedupeStrings,
  mergeMissing,
  pickFirstString,
  setIfPresent,
} from '../util/common';
import { newId } from '../util/id';

export const DEFAULT_ASSISTANT_ID = '0950e2dc-9bd5-4801-afa3-aa887aa36b4e';

export function defaultNormalizedSettings(): Record<string, unknown> {
  return {
    'core.providers': [],
    'core.models': {},
    'core.assistants': [],
    'core.selection': {},
    'sync.webdav': {},
    'sync.s3': {},
    'sync.local': {},
    'ui.profile': {},
    search: {},
    mcp: {},
    tts: {},
    'raw.cherry': {},
    'raw.rikka': {},
    'raw.unsupported': [],
    'normalizer.ver': 1,
    'normalizer.source': '',
  };
}

export function ensureNormalizedSettings(ir: BackupIR): string[] {
  if (Object.keys(ir.settings).length > 0) {
    return [];
  }
  const [normalized, warnings] = normalizeFromSource(ir);
  ir.settings = normalized;
  ir.warnings = dedupeStrings([...ir.warnings, ...warnings]);
  return warnings;
}

export function normalizeFromSource(ir: BackupIR): [Record<string, unknown>, string[]] {
  if (ir.sourceFormat === 'cherry') {
    return normalizeFromCherryConfig(ir.config);
  }
  if (ir.sourceFormat === 'rikka') {
    return normalizeFromRikkaConfig(ir.config);
  }
  return [defaultNormalizedSettings(), []];
}

export function normalizeFromCherryConfig(config: Record<string, unknown>): [Record<string, unknown>, string[]] {
  const out = defaultNormalizedSettings();
  out['normalizer.source'] = 'cherry';

  const warnings: string[] = [];
  const persistSlices = asMap(config['cherry.persistSlices']);
  const settings = Object.keys(asMap(config['cherry.settings'])).length > 0
    ? asMap(cloneAny(config['cherry.settings']))
    : asMap(cloneAny(persistSlices.settings));
  const llm = Object.keys(asMap(config['cherry.llm'])).length > 0
    ? asMap(cloneAny(config['cherry.llm']))
    : asMap(cloneAny(persistSlices.llm));

  out['raw.cherry'] = {
    settings,
    llm,
  };

  const assistantsSlice = asMap(persistSlices.assistants);
  const assistantsRaw = asArray(assistantsSlice.assistants);
  out['core.assistants'] = assistantsRaw
    .map((raw) => {
      const assistant = asMap(raw);
      const model = asMap(assistant.model);
      const setting = asMap(assistant.settings);
      return {
        id: pickFirstString(assistant.id),
        name: pickFirstString(assistant.name),
        systemPrompt: pickFirstString(assistant.prompt),
        chatModelId: pickFirstString(model.id),
        temperature: setting.temperature,
        topP: setting.topP,
        context: setting.contextCount,
        stream: setting.streamOutput,
        maxTokens: setting.maxTokens,
        raw: cloneAny(assistant),
      };
    })
    .filter((item) => asMap(item).id !== '' || asMap(item).name !== '')
    .map((item) => {
      const outItem = asMap(item);
      if (!asString(outItem.id)) {
        outItem.id = newId();
      }
      return outItem;
    });

  const llmProviders = asArray(llm.providers);
  out['core.providers'] = llmProviders.map((rawProvider) => {
    const provider = asMap(rawProvider);
    const sourceType = pickFirstString(provider.type, provider.providerType);
    const [mapped, ok] = cherryProviderToCanonical(sourceType);
    if (!ok) {
      warnings.push(`unsupported cherry provider type: ${sourceType}`);
    }
    const normalized: Record<string, unknown> = {
      id: pickFirstString(provider.id),
      name: pickFirstString(provider.name, provider.id),
      sourceType,
      mappedType: mapped,
      raw: cloneAny(provider),
    };
    if (!asString(normalized.id)) {
      normalized.id = newId();
    }
    return normalized;
  });

  const models: Record<string, unknown> = {};
  for (const key of ['defaultModel', 'quickModel', 'translateModel', 'topicNamingModel']) {
    const value = asMap(llm[key]);
    if (Object.keys(value).length > 0) {
      models[key] = cloneAny(value);
    }
  }
  out['core.models'] = models;

  const selection: Record<string, unknown> = {};
  setIfPresent(selection, 'assistantId', asMap(assistantsSlice.defaultAssistant).id);
  setIfPresent(selection, 'assistantId', settings.assistantId);
  out['core.selection'] = selection;

  const webdav: Record<string, unknown> = {};
  for (const key of [
    'webdavHost',
    'webdavUser',
    'webdavPass',
    'webdavPath',
    'webdavAutoSync',
    'webdavSyncInterval',
    'webdavMaxBackups',
    'webdavSkipBackupFile',
    'webdavDisableStream',
  ]) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      webdav[key] = cloneAny(settings[key]);
    }
  }
  out['sync.webdav'] = webdav;
  out['sync.s3'] = cloneAny(asMap(settings.s3));

  const local: Record<string, unknown> = {};
  for (const key of ['localBackupDir', 'localBackupAutoSync', 'localBackupSyncInterval', 'localBackupMaxBackups', 'localBackupSkipBackupFile']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      local[key] = cloneAny(settings[key]);
    }
  }
  out['sync.local'] = local;

  const uiProfile: Record<string, unknown> = {};
  for (const key of ['userId', 'userName', 'language', 'targetLanguage']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      uiProfile[key] = cloneAny(settings[key]);
    }
  }
  out['ui.profile'] = uiProfile;

  const search: Record<string, unknown> = {};
  for (const key of ['enableWebSearch', 'webSearchProvider', 'webSearchProviders']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      search[key] = cloneAny(settings[key]);
    }
  }
  out.search = search;

  const mcp: Record<string, unknown> = {};
  if (settings.mcpServers) {
    mcp.servers = cloneAny(settings.mcpServers);
  }
  out.mcp = mcp;

  const tts: Record<string, unknown> = {};
  for (const key of ['ttsProviders', 'selectedTTSProviderId']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      tts[key] = cloneAny(settings[key]);
    }
  }
  out.tts = tts;

  return [out, dedupeStrings(warnings)];
}

export function normalizeFromRikkaConfig(config: Record<string, unknown>): [Record<string, unknown>, string[]] {
  const out = defaultNormalizedSettings();
  out['normalizer.source'] = 'rikka';
  const warnings: string[] = [];

  const settings = cloneAny(asMap(config['rikka.settings'])) as Record<string, unknown>;
  out['raw.rikka'] = { settings: cloneAny(settings) };

  const providersRaw = asArray(settings.providers);
  out['core.providers'] = providersRaw.map((providerRaw) => {
    const provider = asMap(providerRaw);
    const sourceType = pickFirstString(provider.type);
    const [mapped, ok] = rikkaProviderToCanonical(sourceType);
    if (!ok) {
      warnings.push(`unsupported rikka provider type: ${sourceType}`);
    }
    const normalized: Record<string, unknown> = {
      id: pickFirstString(provider.id),
      name: pickFirstString(provider.name, provider.id),
      sourceType,
      mappedType: mapped,
      raw: cloneAny(provider),
    };
    if (!asString(normalized.id)) {
      normalized.id = newId();
    }
    return normalized;
  });

  const assistantsRaw = asArray(settings.assistants);
  out['core.assistants'] = assistantsRaw.map((assistantRaw) => {
    const assistant = asMap(assistantRaw);
    const normalized: Record<string, unknown> = {
      id: pickFirstString(assistant.id),
      name: pickFirstString(assistant.name),
      systemPrompt: pickFirstString(assistant.systemPrompt),
      chatModelId: pickFirstString(assistant.chatModelId),
      temperature: assistant.temperature,
      topP: assistant.topP,
      context: assistant.contextMessageSize,
      stream: assistant.streamOutput,
      maxTokens: assistant.maxTokens,
      raw: cloneAny(assistant),
    };
    if (!asString(normalized.id)) {
      normalized.id = newId();
    }
    return normalized;
  });

  const models: Record<string, unknown> = {};
  for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId', 'imageGenerationModelId']) {
    setIfPresent(models, key, settings[key]);
  }
  out['core.models'] = models;

  out['core.selection'] = { assistantId: settings.assistantId };
  out['sync.webdav'] = cloneAny(asMap(settings.webDavConfig));
  out['sync.s3'] = cloneAny(asMap(settings.s3Config));

  const uiProfile: Record<string, unknown> = {};
  if (Object.keys(asMap(settings.displaySetting)).length > 0) {
    uiProfile.displaySetting = cloneAny(settings.displaySetting);
  }
  out['ui.profile'] = uiProfile;

  const search: Record<string, unknown> = {};
  for (const key of ['enableWebSearch', 'searchServices', 'searchCommonOptions', 'searchServiceSelected']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      search[key] = cloneAny(settings[key]);
    }
  }
  out.search = search;

  const mcp: Record<string, unknown> = {};
  if (settings.mcpServers) {
    mcp.servers = cloneAny(settings.mcpServers);
  }
  out.mcp = mcp;

  const tts: Record<string, unknown> = {};
  for (const key of ['ttsProviders', 'selectedTTSProviderId']) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      tts[key] = cloneAny(settings[key]);
    }
  }
  out.tts = tts;

  return [out, dedupeStrings(warnings)];
}

export function buildRikkaSettingsFromIR(
  ir: BackupIR,
  baseSettings: Record<string, unknown>,
): [Record<string, unknown>, string[]] {
  const warnings: string[] = [];
  const settings = cloneAny(baseSettings) as Record<string, unknown>;
  if (Object.keys(settings).length === 0) {
    settings.assistantId = DEFAULT_ASSISTANT_ID;
    settings.providers = [];
    settings.assistants = [];
  }

  const normalized = Object.keys(ir.settings).length > 0 ? ir.settings : normalizeFromSource(ir)[0];

  const providers = buildRikkaProviders(asArray(normalized['core.providers']), warnings);
  if (providers.length > 0) {
    settings.providers = providers;
  } else if (!Array.isArray(settings.providers)) {
    settings.providers = [];
  }

  const assistants = buildRikkaAssistants(ir, asArray(normalized['core.assistants']));
  if (assistants.length > 0) {
    settings.assistants = assistants;
  } else if (!Array.isArray(settings.assistants)) {
    settings.assistants = [];
  }

  const models = asMap(normalized['core.models']);
  for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId', 'imageGenerationModelId']) {
    if (Object.prototype.hasOwnProperty.call(models, key)) {
      settings[key] = cloneAny(models[key]);
    }
  }

  const selection = asMap(normalized['core.selection']);
  if (asString(selection.assistantId)) {
    settings.assistantId = selection.assistantId;
  }

  const webdavRaw = asMap(normalized['sync.webdav']);
  if (Object.keys(webdavRaw).length > 0) {
    const webdav: Record<string, unknown> = {};
    setIfPresent(webdav, 'url', pickFirstString(webdavRaw.url, webdavRaw.webdavHost));
    setIfPresent(webdav, 'username', pickFirstString(webdavRaw.username, webdavRaw.webdavUser));
    setIfPresent(webdav, 'password', pickFirstString(webdavRaw.password, webdavRaw.webdavPass));
    setIfPresent(webdav, 'path', pickFirstString(webdavRaw.path, webdavRaw.webdavPath));
    webdav.items = cloneAny(webdavRaw.items ?? ['DATABASE', 'FILES']);
    settings.webDavConfig = webdav;
  }

  const s3 = asMap(normalized['sync.s3']);
  if (Object.keys(s3).length > 0) {
    const s3Config = cloneAny(s3) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(s3Config, 'items')) {
      s3Config.items = ['DATABASE', 'FILES'];
    }
    settings.s3Config = s3Config;
  }

  const ui = asMap(normalized['ui.profile']);
  if (Object.keys(asMap(ui.displaySetting)).length > 0) {
    settings.displaySetting = cloneAny(ui.displaySetting);
  }

  const search = asMap(normalized.search);
  for (const key of ['enableWebSearch', 'searchServices', 'searchCommonOptions', 'searchServiceSelected']) {
    if (Object.prototype.hasOwnProperty.call(search, key)) {
      settings[key] = cloneAny(search[key]);
    }
  }

  const mcp = asMap(normalized.mcp);
  if (mcp.servers) {
    settings.mcpServers = cloneAny(mcp.servers);
  }

  const tts = asMap(normalized.tts);
  if (tts.ttsProviders) {
    settings.ttsProviders = cloneAny(tts.ttsProviders);
  }
  if (tts.selectedTTSProviderId) {
    settings.selectedTTSProviderId = cloneAny(tts.selectedTTSProviderId);
  }

  if (ir.sourceFormat === 'rikka') {
    mergeMissing(settings, asMap(ir.config['rikka.settings']));
  }

  warnings.push(...enforceRikkaConsistency(settings));
  return [settings, dedupeStrings(warnings)];
}

export function buildCherryPersistSlicesFromIR(
  ir: BackupIR,
  baseSlices: Record<string, unknown>,
  assistantsSlice: Record<string, unknown>,
): [Record<string, unknown>, string[]] {
  const warnings: string[] = [];
  const slices = cloneAny(baseSlices) as Record<string, unknown>;
  const normalized = Object.keys(ir.settings).length > 0 ? ir.settings : normalizeFromSource(ir)[0];

  slices.assistants = cloneAny(assistantsSlice);

  const settings = cloneAny(asMap(slices.settings)) as Record<string, unknown>;
  const llm = cloneAny(asMap(slices.llm)) as Record<string, unknown>;

  const models = asMap(normalized['core.models']);
  for (const key of ['defaultModel', 'quickModel', 'translateModel', 'topicNamingModel']) {
    if (Object.keys(asMap(models[key])).length > 0) {
      llm[key] = cloneAny(models[key]);
    }
  }

  const providers = buildCherryProviders(asArray(normalized['core.providers']), warnings);
  if (providers.length > 0) {
    llm.providers = providers;
  }

  const ui = asMap(normalized['ui.profile']);
  for (const key of ['userId', 'userName', 'language', 'targetLanguage']) {
    if (Object.prototype.hasOwnProperty.call(ui, key)) {
      settings[key] = cloneAny(ui[key]);
    }
  }

  const selection = asMap(normalized['core.selection']);
  if (asString(selection.assistantId)) {
    settings.assistantId = selection.assistantId;
  }

  const webdav = asMap(normalized['sync.webdav']);
  const copyWebdav = (dst: string, ...src: string[]): void => {
    for (const key of src) {
      if (Object.prototype.hasOwnProperty.call(webdav, key)) {
        settings[dst] = cloneAny(webdav[key]);
        return;
      }
    }
  };
  copyWebdav('webdavHost', 'webdavHost', 'url');
  copyWebdav('webdavUser', 'webdavUser', 'username');
  copyWebdav('webdavPass', 'webdavPass', 'password');
  copyWebdav('webdavPath', 'webdavPath', 'path');
  copyWebdav('webdavAutoSync', 'webdavAutoSync');
  copyWebdav('webdavSyncInterval', 'webdavSyncInterval');
  copyWebdav('webdavMaxBackups', 'webdavMaxBackups');
  copyWebdav('webdavSkipBackupFile', 'webdavSkipBackupFile');
  copyWebdav('webdavDisableStream', 'webdavDisableStream');

  const s3 = asMap(normalized['sync.s3']);
  if (Object.keys(s3).length > 0) {
    settings.s3 = cloneAny(s3);
  }

  const local = asMap(normalized['sync.local']);
  for (const key of ['localBackupDir', 'localBackupAutoSync', 'localBackupSyncInterval', 'localBackupMaxBackups', 'localBackupSkipBackupFile']) {
    if (Object.prototype.hasOwnProperty.call(local, key)) {
      settings[key] = cloneAny(local[key]);
    }
  }

  const search = asMap(normalized.search);
  mergeMissing(settings, search);

  const mcp = asMap(normalized.mcp);
  if (mcp.servers) {
    settings.mcpServers = cloneAny(mcp.servers);
  }

  const tts = asMap(normalized.tts);
  mergeMissing(settings, tts);

  if (ir.sourceFormat === 'cherry') {
    mergeMissing(settings, asMap(ir.config['cherry.settings']));
    mergeMissing(llm, asMap(ir.config['cherry.llm']));
  }

  if (!asString(settings.userId)) {
    settings.userId = newId();
  }
  if (!Object.prototype.hasOwnProperty.call(settings, 'skipBackupFile')) {
    settings.skipBackupFile = false;
  }

  slices.settings = settings;
  slices.llm = llm;
  return [slices, dedupeStrings(warnings)];
}

function buildRikkaProviders(coreProviders: unknown[], warnings: string[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const value of coreProviders) {
    const provider = asMap(value);
    const mappedType = pickFirstString(provider.mappedType);
    const rikkaType = canonicalToRikkaType(mappedType);
    if (!rikkaType) {
      warnings.push('skip unsupported canonical provider mapping to rikka');
      continue;
    }
    const raw = cloneAny(asMap(provider.raw)) as Record<string, unknown>;
    if (!asString(raw.id)) raw.id = pickFirstString(provider.id, newId());
    if (!asString(raw.name)) raw.name = pickFirstString(provider.name, mappedType.toUpperCase());
    raw.type = rikkaType;
    if (!Array.isArray(raw.models)) {
      raw.models = [];
    }
    if (!asString(raw.baseUrl) && asString(raw.apiHost)) {
      raw.baseUrl = raw.apiHost;
    }
    result.push(raw);
  }
  return result;
}

function buildRikkaAssistants(ir: BackupIR, coreAssistants: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const pushAssistant = (assistant: Record<string, unknown>): void => {
    if (!asString(assistant.id)) assistant.id = newId();
    if (!asString(assistant.name)) assistant.name = 'Imported Assistant';
    if (!Object.prototype.hasOwnProperty.call(assistant, 'streamOutput')) assistant.streamOutput = true;
    if (!Object.prototype.hasOwnProperty.call(assistant, 'contextMessageSize')) assistant.contextMessageSize = 64;
    result.push(assistant);
  };

  for (const value of coreAssistants) {
    const assistant = asMap(value);
    const raw = cloneAny(asMap(assistant.raw)) as Record<string, unknown>;
    raw.id = pickFirstString(raw.id, assistant.id);
    raw.name = pickFirstString(raw.name, assistant.name);
    raw.systemPrompt = pickFirstString(raw.systemPrompt, assistant.systemPrompt);
    raw.chatModelId = pickFirstString(raw.chatModelId, assistant.chatModelId);
    if (!Object.prototype.hasOwnProperty.call(raw, 'temperature')) raw.temperature = assistant.temperature;
    if (!Object.prototype.hasOwnProperty.call(raw, 'topP')) raw.topP = assistant.topP;
    if (!Object.prototype.hasOwnProperty.call(raw, 'contextMessageSize')) raw.contextMessageSize = assistant.context;
    if (!Object.prototype.hasOwnProperty.call(raw, 'streamOutput')) raw.streamOutput = assistant.stream;
    if (!Object.prototype.hasOwnProperty.call(raw, 'maxTokens')) raw.maxTokens = assistant.maxTokens;
    pushAssistant(raw);
  }

  if (result.length > 0 || ir.assistants.length === 0) {
    return result;
  }

  for (const assistant of ir.assistants) {
    const raw: Record<string, unknown> = {
      id: pickFirstString(assistant.id),
      name: pickFirstString(assistant.name, 'Imported Assistant'),
      systemPrompt: assistant.prompt ?? '',
      chatModelId: pickFirstString(assistant.model?.chatModelId, assistant.model?.id),
      temperature: assistant.settings?.temperature,
      topP: assistant.settings?.topP,
      contextMessageSize: assistant.settings?.contextCount,
      streamOutput: assistant.settings?.streamOutput,
      maxTokens: assistant.settings?.maxTokens,
    };
    pushAssistant(raw);
  }

  return result;
}

function buildCherryProviders(coreProviders: unknown[], warnings: string[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const value of coreProviders) {
    const provider = asMap(value);
    const mappedType = pickFirstString(provider.mappedType);
    const sourceType = pickFirstString(provider.sourceType);
    const cherryType = canonicalToCherryType(mappedType, sourceType);
    if (!cherryType) {
      warnings.push('skip unsupported canonical provider mapping to cherry');
      continue;
    }
    const raw = cloneAny(asMap(provider.raw)) as Record<string, unknown>;
    if (!asString(raw.id)) raw.id = pickFirstString(provider.id, newId());
    if (!asString(raw.name)) raw.name = pickFirstString(provider.name, mappedType.toUpperCase());
    raw.type = cherryType;
    if (!Array.isArray(raw.models)) {
      raw.models = [];
    }
    if (!asString(raw.apiHost) && asString(raw.baseUrl)) {
      raw.apiHost = raw.baseUrl;
    }
    result.push(raw);
  }
  return result;
}

function enforceRikkaConsistency(settings: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const assistants = asArray(settings.assistants).map((value) => asMap(value));
  const assistantIds = new Set<string>();
  const normalizedAssistants = assistants.map((assistant) => {
    const out = cloneAny(assistant) as Record<string, unknown>;
    if (!asString(out.id)) {
      out.id = newId();
    }
    assistantIds.add(asString(out.id));
    return out;
  });
  settings.assistants = normalizedAssistants;

  if (assistantIds.size > 0) {
    const selected = asString(settings.assistantId);
    if (!assistantIds.has(selected)) {
      settings.assistantId = normalizedAssistants[0].id;
      warnings.push('selected assistant not found, fallback to first assistant');
    }
  } else if (!asString(settings.assistantId)) {
    settings.assistantId = DEFAULT_ASSISTANT_ID;
  }

  const modelIds = new Set<string>();
  for (const providerValue of asArray(settings.providers)) {
    const provider = asMap(providerValue);
    for (const modelValue of asArray(provider.models)) {
      const model = asMap(modelValue);
      const modelId = asString(model.id);
      if (modelId) {
        modelIds.add(modelId);
      }
    }
  }

  for (const key of ['chatModelId', 'titleModelId', 'translateModeId', 'suggestionModelId']) {
    const selectedId = asString(settings[key]);
    if (selectedId && !modelIds.has(selectedId)) {
      warnings.push(`selected model ${key} not found in providers`);
    }
  }

  return warnings;
}

function cherryProviderToCanonical(sourceType: string): [string, boolean] {
  const normalized = sourceType.trim().toLowerCase();
  if (['openai', 'openai-response', 'new-api', 'gateway', 'azure-openai', 'ollama', 'lmstudio', 'gpustack', 'aws-bedrock'].includes(normalized)) {
    return ['openai', true];
  }
  if (['anthropic', 'vertex-anthropic'].includes(normalized)) {
    return ['claude', true];
  }
  if (['gemini', 'vertexai'].includes(normalized)) {
    return ['google', true];
  }
  return ['', false];
}

function rikkaProviderToCanonical(sourceType: string): [string, boolean] {
  const normalized = sourceType.trim().toLowerCase();
  if (normalized === 'openai') return ['openai', true];
  if (normalized === 'claude') return ['claude', true];
  if (normalized === 'google') return ['google', true];
  return ['', false];
}

function canonicalToRikkaType(mappedType: string): string {
  const normalized = mappedType.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'google') return 'google';
  return '';
}

function canonicalToCherryType(mappedType: string, sourceType: string): string {
  if (sourceType.trim()) {
    const [sourceMapped, ok] = cherryProviderToCanonical(sourceType);
    if (ok && (!mappedType.trim() || sourceMapped === mappedType.trim().toLowerCase())) {
      return sourceType;
    }
  }
  const normalized = mappedType.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'claude') return 'anthropic';
  if (normalized === 'google') return 'gemini';
  return '';
}
