/**
 * Regenerates the "Projects" and "Collaborations" tables in README.md, ranked
 * by how many commits the user actually contributed to each repository over
 * the past year.
 *
 * Ranking by commit count (rather than stars or push date) means the tables
 * reorder themselves as work shifts between projects: the repo you commit to
 * most this year sits at the top.
 *
 * Projects lists repos the user owns. Collaborations lists public repos owned
 * by someone else — orgs, teammates, upstreams — that the user committed to.
 *
 * Private repos are never named. They collapse into a single aggregate block:
 * repo count, commit count, PR count, and the languages involved. Names and
 * owners are deliberately dropped — the links would 404 for every visitor
 * anyway, and a public README is the wrong place to enumerate client work.
 *
 * Requires GITHUB_TOKEN with `read:user`. Private repos additionally need a
 * fine-grained PAT with Metadata: read-only (see projects.yml). Without it the
 * private block reads zero rather than failing.
 */

const TOP_N = 6;
const TOP_N_COLLABS = 6;
const TOP_N_LANGS = 8;
const MARKERS = {
  projects: ['<!-- PROJECTS:START -->', '<!-- PROJECTS:END -->'],
  collabs: ['<!-- COLLABS:START -->', '<!-- COLLABS:END -->'],
  private: ['<!-- PRIVATE:START -->', '<!-- PRIVATE:END -->'],
};

const token = process.env.GITHUB_TOKEN;
const login = process.env.USERNAME;

if (!token || !login) {
  console.error('Missing GITHUB_TOKEN or USERNAME');
  process.exit(1);
}

const repoFields = `
  name
  url
  description
  stargazerCount
  isFork
  isPrivate
  isArchived
  primaryLanguage { name }
  owner { login }
`;

const query = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { ${repoFields} }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { name owner { login } }
        }
      }
    }
  }
`;

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'update-projects-script',
  },
  body: JSON.stringify({ query, variables: { login } }),
});

if (!res.ok) {
  console.error(`GitHub API returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const body = await res.json();

if (body.errors) {
  console.error('GraphQL errors:', JSON.stringify(body.errors, null, 2));
  process.exit(1);
}

const collection = body.data.user.contributionsCollection;

// PR counts arrive in a separate bucket from commit counts, so key them by
// nameWithOwner and look them up while building rows.
const prCounts = new Map(
  collection.pullRequestContributionsByRepository.map((entry) => [
    `${entry.repository.owner.login}/${entry.repository.name}`.toLowerCase(),
    entry.contributions.totalCount,
  ]),
);

const all = collection.commitContributionsByRepository
  .map((entry) => ({ ...entry.repository, commits: entry.contributions.totalCount }))
  .filter((r) => !r.isFork && !r.isArchived)
  .sort((a, b) => b.commits - a.commits || b.stargazerCount - a.stargazerCount);

const isOwn = (r) => r.owner.login.toLowerCase() === login.toLowerCase();

const publicRepos = all.filter((r) => !r.isPrivate);
const privateRepos = all.filter((r) => r.isPrivate);

const owned = publicRepos.filter(isOwn).slice(0, TOP_N);
const collabs = publicRepos.filter((r) => !isOwn(r)).slice(0, TOP_N_COLLABS);

// Bail without writing rather than publishing an empty table: a transient API
// hiccup should leave the last good README in place.
if (owned.length === 0) {
  console.error('No repositories returned — leaving README unchanged.');
  process.exit(1);
}

const escape = (s) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const prsFor = (r) => prCounts.get(`${r.owner.login}/${r.name}`.toLowerCase()) ?? 0;

const generated = new Date().toISOString().slice(0, 10);

const projectRows = owned.map((r) => {
  const desc = truncate(escape(r.description) || '—', 90);
  const lang = r.primaryLanguage?.name ?? '—';
  const stars = r.stargazerCount > 0 ? `⭐ ${r.stargazerCount}` : '—';
  return `| **[${r.name}](${r.url})** | ${desc} | ${lang} | ${r.commits} | ${stars} |`;
});

const projectsSection = [
  '| Project | Description | Language | Commits | Stars |',
  '| --- | --- | --- | --: | --: |',
  ...projectRows,
  '',
  `<sub>Ranked by commits over the past year · updated ${generated}</sub>`,
].join('\n');

const collabRows = collabs.map((r) => {
  const desc = truncate(escape(r.description) || '—', 70);
  const prs = prsFor(r);
  return (
    `| **[${r.name}](${r.url})** | [@${r.owner.login}](https://github.com/${r.owner.login}) | ` +
    `${desc} | ${r.commits} | ${prs > 0 ? prs : '—'} |`
  );
});

const collabsSection = collabRows.length
  ? [
      '| Repository | Owner | Description | Commits | PRs |',
      '| --- | --- | --- | --: | --: |',
      ...collabRows,
      '',
      `<sub>Public repos I don't own, ranked by my commits over the past year · updated ${generated}</sub>`,
    ].join('\n')
  : `<sub>No public collaborations in the past year · updated ${generated}</sub>`;

// Private repos contribute counts and languages only. Nothing here reaches the
// README that could identify a repo, an owner, or a client.
const privateCommits = privateRepos.reduce((sum, r) => sum + r.commits, 0);
const privatePrs = privateRepos.reduce((sum, r) => sum + prsFor(r), 0);

// Rank languages by commits behind them, not by repo count: one heavily worked
// service says more about the stack than three dormant repos.
const langWeights = new Map();
for (const r of privateRepos) {
  const lang = r.primaryLanguage?.name;
  if (lang) langWeights.set(lang, (langWeights.get(lang) ?? 0) + r.commits);
}
const privateLangs = [...langWeights.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, TOP_N_LANGS)
  .map(([lang]) => lang);

const privateSection = privateRepos.length
  ? [
      '<p align="center">',
      `  <strong>${privateRepos.length}</strong> private ${privateRepos.length === 1 ? 'repository' : 'repositories'} · ` +
        `<strong>${privateCommits}</strong> ${privateCommits === 1 ? 'commit' : 'commits'}` +
        (privatePrs > 0 ? ` · <strong>${privatePrs}</strong> ${privatePrs === 1 ? 'PR' : 'PRs'}` : ''),
      '</p>',
      ...(privateLangs.length
        ? ['', `<p align="center">${privateLangs.join(' · ')}</p>`]
        : []),
      '',
      // Centered to match the stat lines above it. The Projects and
      // Collaborations captions stay left-aligned to match their tables.
      `<p align="center"><sub>Counts only — repo names and owners withheld · past year · updated ${generated}</sub></p>`,
    ].join('\n')
  : `<p align="center"><sub>No private contributions to report · updated ${generated}</sub></p>`;

const fs = await import('node:fs/promises');
let readme = await fs.readFile('README.md', 'utf8');

const replaceSection = (source, [start, end], content) => {
  if (!source.includes(start) || !source.includes(end)) {
    console.error(`README.md is missing the ${start} / ${end} markers.`);
    process.exit(1);
  }
  return source.replace(
    new RegExp(`${start}[\\s\\S]*?${end}`),
    () => [start, '', content, '', end].join('\n'),
  );
};

readme = replaceSection(readme, MARKERS.projects, projectsSection);
readme = replaceSection(readme, MARKERS.collabs, collabsSection);
readme = replaceSection(readme, MARKERS.private, privateSection);

await fs.writeFile('README.md', readme);

console.log(`Updated Projects table with ${owned.length} repositories:`);
for (const r of owned) console.log(`  ${String(r.commits).padStart(4)} commits  ${r.name}`);
console.log(`Updated Collaborations table with ${collabs.length} repositories:`);
for (const r of collabs) {
  console.log(`  ${String(r.commits).padStart(4)} commits  ${r.owner.login}/${r.name}`);
}
// Names intentionally omitted from this log too — Actions logs are public on
// a public repo.
console.log(
  `Private aggregate: ${privateRepos.length} repos, ${privateCommits} commits, ${privatePrs} PRs`,
);
if (privateRepos.length === 0) {
  console.log('  (zero private repos — check that GH_PAT grants Metadata: read-only)');
}
