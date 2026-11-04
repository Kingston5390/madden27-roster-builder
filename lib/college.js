// Real college players from ESPN, for adding to a draft class: search by name, then fill in each player's details.
'use strict';
const SEARCH = 'https://site.web.api.espn.com/apis/search/v2?limit=10&type=player&query=';
const ATHLETE = 'https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/';
// ESPN position -> Madden position index (QB HB FB WR TE LT LG C RG RT LE RE DT LOLB MLB ROLB CB FS SS K P)
const POSITION = { QB: 0, RB: 1, HB: 1, FB: 2, WR: 3, ATH: 3, TE: 4, OT: 5, T: 5, OL: 6, G: 6, OG: 6, IOL: 6, C: 7, LS: 7, DE: 11, EDGE: 11,
  DL: 12, DT: 12, NT: 12, OLB: 13, LB: 14, ILB: 14, MLB: 14, CB: 16, DB: 16, S: 17, FS: 17, SAF: 17, SS: 18, K: 19, PK: 19, P: 20 };
// ESPN has no birth dates for college players: a typical age at draft time for each class year
const AGE = { Freshman: 20, Sophomore: 21, Junior: 21, Senior: 22, Graduate: 23 };
const inches = s => { const m = /(\d+)'\s*(\d+)/.exec(s ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) : null; };

async function searchCollegePlayers(query) {
  const r = await (await fetch(SEARCH + encodeURIComponent(query))).json();
  const hits = (r.results ?? []).flatMap(x => x.contents ?? []).filter(c => /~l:23~a:\d+/.test(c.uid ?? '')).slice(0, 8);
  const players = await Promise.all(hits.map(async h => {
    const id = /~a:(\d+)/.exec(h.uid)[1];
    try {
      const a = (await (await fetch(ATHLETE + id)).json()).athlete;
      return {
        espnId: Number(id), firstName: a.firstName, lastName: a.lastName,
        school: a.team?.displayName ?? h.subtitle, schoolId: Number(a.team?.id) || null,
        espnPosition: a.position?.abbreviation ?? '', position: POSITION[a.position?.abbreviation] ?? null,
        height: inches(a.displayHeight), weight: parseInt(a.displayWeight, 10) || null, age: AGE[a.displayExperience] ?? 21,
        experience: a.displayExperience ?? '', hometown: a.displayBirthPlace ?? '',
        jersey: parseInt(String(a.displayJersey ?? '').replace('#', ''), 10), headshot: a.headshot?.href ?? null,
      };
    } catch { return null; } // one player's details failing shouldn't sink the search
  }));
  return players.filter(Boolean);
}

module.exports = { searchCollegePlayers };
