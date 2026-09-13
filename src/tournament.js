export function createSchedule(members) {
  if (!Array.isArray(members) || members.length < 3 || members.length > 4) throw new Error('A tournament needs 3 or 4 players.');
  const players = members.map(({ token, name }) => ({ token, name }));
  if (players.length === 3) players.push(null);
  const rounds = [];
  let ring = [...players];
  for (let round = 0; round < ring.length - 1; round++) {
    const matches = [];
    for (let i = 0; i < ring.length / 2; i++) {
      const a = ring[i], b = ring[ring.length - 1 - i];
      if (a && b) matches.push({ id: `r${round + 1}m${matches.length + 1}`, a: a.token, b: b.token, reports: {}, winner: null, draw: false });
    }
    rounds.push(matches);
    ring = [ring[0], ring.at(-1), ...ring.slice(1, -1)];
  }
  return { members, rounds, roundIndex: 0, started: true, complete: false };
}

export function activeMatch(tournament, token) {
  return tournament?.rounds?.[tournament.roundIndex]?.find(match => !match.winner && !match.draw && (match.a === token || match.b === token)) || null;
}

export function memberName(tournament, token) {
  return tournament?.members?.find(member => member.token === token)?.name || 'Player';
}

export function recordResult(tournament, matchId, token, report) {
  const match = tournament?.rounds?.flat().find(item => item.id === matchId);
  if (!match || ![match.a, match.b].includes(token) || match.winner || match.draw) return false;
  if (!report || !['win', 'loss', 'tie'].includes(report.outcome) || !Number.isInteger(report.attempts) || !Number.isInteger(report.timeMs)) return false;
  match.reports[token] = { outcome: report.outcome, attempts: report.attempts, timeMs: report.timeMs };
  const a = match.reports[match.a], b = match.reports[match.b];
  if (!a || !b) return true;
  if (a.outcome === 'win' && b.outcome === 'loss') match.winner = match.a;
  else if (b.outcome === 'win' && a.outcome === 'loss') match.winner = match.b;
  else if (a.outcome === 'tie' && b.outcome === 'tie') match.draw = true;
  else {
    delete match.reports[token];
    return false;
  }
  return true;
}

export function roundComplete(tournament) {
  const round = tournament?.rounds?.[tournament.roundIndex] || [];
  return round.length > 0 && round.every(match => match.winner || match.draw);
}

export function advanceTournament(tournament) {
  if (!roundComplete(tournament)) return false;
  if (tournament.roundIndex >= tournament.rounds.length - 1) tournament.complete = true;
  else tournament.roundIndex++;
  return true;
}

export function standings(tournament) {
  const table = (tournament?.members || []).map(member => ({ ...member, played: 0, wins: 0, draws: 0, losses: 0, points: 0, attempts: 0, timeMs: 0 }));
  const byToken = new Map(table.map(row => [row.token, row]));
  for (const match of tournament?.rounds?.flat() || []) {
    if (!match.winner && !match.draw) continue;
    const a = byToken.get(match.a), b = byToken.get(match.b);
    a.played++; b.played++;
    for (const [token, report] of Object.entries(match.reports)) {
      const row = byToken.get(token);
      row.attempts += report.attempts;
      row.timeMs += report.timeMs;
    }
    if (match.draw) { a.draws++; b.draws++; a.points++; b.points++; }
    else {
      const winner = byToken.get(match.winner), loser = byToken.get(match.winner === match.a ? match.b : match.a);
      winner.wins++; winner.points += 3; loser.losses++;
    }
  }
  return table.sort((a, b) => b.points - a.points || b.wins - a.wins || a.attempts - b.attempts || a.timeMs - b.timeMs || a.name.localeCompare(b.name));
}
