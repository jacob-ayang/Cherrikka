export type AppLang = 'zh' | 'en';

export interface I18nText {
  appTitle: string;
  appSubtitle: string;
  sourceFileLabel: string;
  sourceFileHint: string;
  sourceFormat: string;
  sourceFormatAuto: string;
  sourceFormatCherry: string;
  sourceFormatRikka: string;
  targetFormat: string;
  targetPending: string;
  targetCherry: string;
  targetRikka: string;
  redactSecrets: string;
  convert: string;
  converting: string;
  download: string;
  detectSource: string;
  progress: string;
  statusIdle: string;
  statusDone: string;
  statusFailed: string;
  errorPrefix: string;
  language: string;
}
