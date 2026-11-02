/**
 * A browser's user agent, cut down to what staff need to spot a pattern in
 * call quality: the system with its major version, and the browser — including
 * the in-app browsers (Instagram, TikTok, …) that people open links in, which
 * often handle audio worst. Nothing finer, so it can't single anyone out.
 */
export interface Device {
  os: string;
  browser: string;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, 'Instagram app'],
  [/FBAN|FBAV|FB_IAB/i, 'Facebook app'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok app'],
  [/Snapchat/i, 'Snapchat app'],
  [/Twitter|TwitterAndroid/i, 'X app'],
  [/WhatsApp/i, 'WhatsApp'],
];

export function describeDevice(ua: string | undefined): Device {
  const agent = ua ?? '';
  const version = (pattern: RegExp) => agent.match(pattern)?.[1]?.replace(/_/g, '.').split('.')[0];

  let os = 'Other';
  if (/iPhone|iPad|iPod/.test(agent)) os = `iOS ${version(/OS (\d+)[_.]/) ?? ''}`.trim();
  else if (/Android/.test(agent)) os = `Android ${version(/Android (\d+)/) ?? ''}`.trim();
  else if (/Windows/.test(agent)) os = 'Windows';
  else if (/Mac OS X/.test(agent)) os = 'macOS';
  else if (/CrOS/.test(agent)) os = 'ChromeOS';
  else if (/Linux/.test(agent)) os = 'Linux';

  const app = IN_APP.find(([pattern]) => pattern.test(agent));
  let browser = 'Other';
  if (app) browser = app[1];
  else if (/SamsungBrowser/.test(agent)) browser = 'Samsung Internet';
  else if (/OPR\/|Opera/.test(agent)) browser = 'Opera';
  else if (/Edg\//.test(agent)) browser = 'Edge';
  else if (/Firefox|FxiOS/.test(agent)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(agent)) browser = 'Chrome';
  else if (/Safari\//.test(agent)) browser = 'Safari';
  return { os, browser };
}
