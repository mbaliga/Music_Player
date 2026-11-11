// ─────────────────────────────────────────────────────────────────────────────
// policy.js — which kind of show runs? PURE. One function and one table, so the picker, the session and the future cloud
// phase (P2) all answer the question the same way.
//
//   chooseShowSource({ online, cloudAvailable, flagOn, userStation, lastSource })
//       -> { source: 'cloud' | 'offline-host' | 'canned' | null, reason, degraded, sticky }
//
//   userStation   what the owner picked: a station object ({type}), a type string, or null / 'auto'
//                   'canned'                      a pre-written station
//                   'ai-you'                      You Radio (the offline templated host today)
//                   'ai-style' / 'ai-you-city'    an AI style from the bibles / You City: cloud-only
//                   'radio-browser'               a real internet station (not a "show"; source null while online)
//                   null | 'auto'                 "just play something"
//   lastSource    the source of the show running RIGHT NOW (null when starting fresh)
//   cloudAvailable  false until the cloud phase ships (CLOUD_AVAILABLE below). While it is false 'cloud' is never returned.
//
// Table (online = navigator.onLine; "cloud ok" = cloudAvailable && online && flagOn):
//   canned                       -> canned                                   always (it needs nothing)
//   ai-you   flag off            -> canned    ("AI stations are off")        (the row is hidden then anyway)
//   ai-you   cloud ok            -> cloud
//   ai-you   otherwise           -> offline-host                             "Auto" for You Radio = on this phone
//   ai-style / you-city, flag off or cloud not ok -> canned                  cloud-only styles degrade to a pre-written show
//   ai-style / you-city, cloud ok -> cloud
//   auto     cloud ok            -> cloud;  flag on -> offline-host;  else canned
//   radio-browser  online        -> null (a stream, not a show);  offline -> canned ("the app must still have radio")
//   lastSource 'cloud' and cloud no longer ok -> canned, degraded:true       (dead-air ladder: going offline mid-show)
//   lastSource 'canned'/'offline-host' and the answer would be 'cloud' -> stay (sticky:true); the next fresh start re-decides
// ─────────────────────────────────────────────────────────────────────────────

/** Flip when the cloud stations exist (P2). Everything that asks goes through this, so there is one place to change. */
export const CLOUD_AVAILABLE = false;

export const SOURCES = Object.freeze(['cloud', 'offline-host', 'canned']);

function kindOf(userStation) {
  const t = typeof userStation === 'string' ? userStation : userStation && typeof userStation === 'object' ? userStation.type : null;
  if (!t || t === 'auto') return 'auto';
  if (t === 'canned') return 'canned';
  if (t === 'ai-you') return 'you';
  if (t === 'ai-style' || t === 'ai-you-city') return 'style';
  if (t === 'radio-browser') return 'real';
  return 'auto';
}

export function chooseShowSource({ online = true, cloudAvailable = false, flagOn = false, userStation = null, lastSource = null } = {}) {
  const cloudOk = cloudAvailable === true && online !== false && flagOn === true;
  const kind = kindOf(userStation);
  const out = (source, reason, extra = {}) => ({ source, reason, degraded: false, sticky: false, ...extra });
  try {
    // 1. a show already on air: never swap it from under the listener except to rescue it
    if (lastSource === 'cloud' && !cloudOk && kind !== 'real') {
      return out('canned', online === false ? 'went offline mid-show: pre-written show takes over' : 'the cloud show failed: pre-written show takes over', { degraded: true });
    }
    // 2. by what the owner picked
    if (kind === 'canned') return out('canned', 'a pre-written station was chosen');
    if (kind === 'real') return online === false ? out('canned', 'offline: real stations need a network, so a pre-written show plays') : out(null, 'a real stream, not a show');
    let pick;
    if (kind === 'you') {
      if (!flagOn) pick = out('canned', 'AI stations are off');
      else if (cloudOk) pick = out('cloud', 'cloud is available');
      else pick = out('offline-host', cloudAvailable !== true ? 'the cloud stations are not available yet: You Radio runs on this phone' : 'offline: You Radio runs on this phone');
    } else if (kind === 'style') {
      if (cloudOk) pick = out('cloud', 'cloud is available');
      else pick = out('canned', !flagOn ? 'AI stations are off' : cloudAvailable !== true ? 'needs internet (coming soon): a pre-written show plays' : 'offline: a pre-written show plays', { degraded: flagOn });
    } else { // auto
      if (cloudOk) pick = out('cloud', 'cloud is available');
      else if (flagOn) pick = out('offline-host', 'Auto: You Radio runs on this phone');
      else pick = out('canned', online === false ? 'offline: a pre-written show plays' : 'AI stations are off: a pre-written show plays');
    }
    if (pick.source === 'cloud' && (lastSource === 'canned' || lastSource === 'offline-host')) return { ...pick, source: lastSource, sticky: true, reason: `staying on ${lastSource} until the next start` };
    return pick;
  } catch {
    return out('canned', 'policy error: pre-written show');
  }
}
