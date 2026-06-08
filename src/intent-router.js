
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const URL_RE = /^https?:\/\//i;

export function normalizeInput(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return {
    raw: String(raw ?? ''),
    text,
    lower: text.toLowerCase(),
    isEmpty: text.length === 0,
    isShort: text.split(/\s+/).filter(Boolean).length <= 6,
  };
}

export function routeIntent(raw) {
  const input = normalizeInput(raw);
  if (input.isEmpty) {
    return baseRoute(input, 'idea_brief', 'empty', 'What must be clarified before anyone can react?', ['operator', 'skeptic', 'buyer']);
  }

  if (ADDRESS_RE.test(input.text)) {
    return {
      ...baseRoute(input, 'synthetic_launch', 'contract_address', 'Would Base traders buy, hold, ignore, farm, or sell this after first exposure?', [
        'Base trader', 'early holder', 'meme buyer', 'skeptical KOL', 'liquidity watcher'
      ]),
      chain: 'base',
      contractAddress: input.text,
    };
  }

  if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(input.text)) {
    return baseRoute(input, 'synthetic_launch', 'x_status', 'Will the public thread create belief, demand proof, farm attention, or trigger rejection?', [
      'trader', 'holder', 'KOL watcher', 'skeptical reply guy', 'community mod'
    ]);
  }

  if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?!home|explore|search|notifications|messages|i|settings|compose|intent|share|tos|privacy|login|signup|hashtag|communities)(?:@)?[^/?#]+\/?$/i.test(input.text)) {
    return baseRoute(input, 'x_profile_market', 'x_profile', 'What does this account repeatedly claim, prove, and fail to prove to its market?', [
      'skim follower', 'technical skeptic', 'builder peer', 'KOL watcher', 'trust/risk filter'
    ]);
  }

  if (URL_RE.test(input.text)) {
    return baseRoute(input, 'product_surface', 'url', 'Will first-time visitors understand, trust, and try this before they bounce?', [
      'founder', 'PM', 'buyer', 'impatient visitor', 'skeptical user'
    ]);
  }

  if (isOpenWorldQuestion(input.text)) {
    const openWorld = classifyOpenWorldQuestion(input.text);
    return {
      ...baseRoute(input, 'open_world_question', 'question', 'What is the best answer after understanding the domain, collecting relevant signals, and testing uncertainty?', openWorld.audience),
      openWorldDomain: openWorld.domain,
      openWorldSubdomain: openWorld.subdomain,
      answerType: openWorld.answerType,
    };
  }

  const launchWords = /\b(token|tge|ca|base|meme|memecoin|dex|launch|airdrop|holder|holders|market cap|liquidity|ape|trader|buy|sell)\b/i;
  if (launchWords.test(input.text)) {
    return baseRoute(input, 'synthetic_launch', 'brief', 'Would crypto-native users buy, hold, ignore, farm, or sell this launch?', [
      'trader', 'holder', 'KOL watcher', 'meme buyer', 'utility believer'
    ]);
  }

  const productWords = /\b(landing|pricing|onboarding|copy|website|page|devtool|saas|app|demo|docs|signup|waitlist)\b/i;
  if (productWords.test(input.text)) {
    return baseRoute(input, 'product_surface', 'brief', 'Will first-time users understand the value, trust the proof, and know what to do next?', [
      'founder', 'PM', 'buyer', 'developer', 'impatient visitor'
    ]);
  }

  return baseRoute(input, 'idea_brief', 'brief', 'Will the intended audience believe the brief, act on it, ask for more proof, or reject it?', [
    'curious user', 'skeptic', 'buyer', 'builder', 'operator'
  ]);
}

function isOpenWorldQuestion(text) {
  const question = /\?\s*$/.test(text) || /^(who|what|when|where|why|how|which|should|can|will)\b/i.test(text);
  if (!question) return false;
  const productOrLaunch = /\b(token|tge|ca|base|meme|memecoin|dex|launch|airdrop|holder|holders|market cap|liquidity|ape|trader|landing|pricing|onboarding|copy|website|page|signup|waitlist)\b/i;
  return !productOrLaunch.test(text);
}

function classifyOpenWorldQuestion(text) {
  const lower = String(text || '').toLowerCase();
  const answerType = /\b(who will|will .* win|winner|champion|forecast|predict|2026)\b/i.test(text) ? 'forecast'
    : /\b(how|should|best|recommend)\b/i.test(text) ? 'recommendation'
      : /\b(why|explain)\b/i.test(text) ? 'explanation'
        : 'answer';
  if (/\b(f1|formula\s*1|formula one|grand prix|verstappen|ferrari|mclaren|mercedes|red bull)\b/i.test(lower)) {
    return {
      domain: 'sports',
      subdomain: 'f1',
      answerType,
      audience: ['F1 analyst', 'race strategist', 'technical regulation watcher', 'skeptical sports fan', 'casual fan'],
    };
  }
  if (/\b(fifa|world cup|soccer|football|uefa|champions league|premier league|la liga)\b/i.test(lower)) {
    return {
      domain: 'sports',
      subdomain: 'football',
      answerType,
      audience: ['football analyst', 'tournament forecaster', 'squad-depth scout', 'skeptical sports fan', 'casual fan'],
    };
  }
  if (/\b(nba|nfl|tennis|ufc|champion|championship|grand slam)\b/i.test(lower)) {
    return {
      domain: 'sports',
      subdomain: 'general-sports',
      answerType,
      audience: ['sports analyst', 'form watcher', 'matchup scout', 'skeptical sports fan', 'casual fan'],
    };
  }
  if (/\b(car|cars|vehicle|vehicles|toyota|tesla|bmw|mercedes|honda|ford|hyundai|kia|mazda|subaru|ev|suv|sedan|truck)\b/i.test(lower)) {
    return { domain: 'automotive', subdomain: 'car-buying', answerType, audience: ['car buyer', 'reliability nerd', 'total-cost owner', 'safety checker', 'skeptical mechanic'] };
  }
  if (/\b(github|repo|repository|open source|library|framework|api|sdk|code|developer|package|javascript|typescript|python|react|next\.js|vue|svelte)\b/i.test(lower)) {
    return { domain: 'technical', subdomain: 'software', answerType, audience: ['developer', 'maintainer', 'security reviewer', 'docs reader', 'operator'] };
  }
  if (/\b(school|kid|child|children|parent|parents|family|daycare|kindergarten|teacher|teachers|education|college|nursery|childcare|screen time|7-year-old|year-old|toddler|pediatric|parenting)\b/i.test(lower)) {
    return { domain: 'family', subdomain: /\b(school|teacher|education|college)\b/i.test(lower) ? 'school_selection' : 'family_decision', answerType, audience: ['parent', 'child-fit advocate', 'safety checker', 'teacher-quality reader', 'support-needs checker'] };
  }
  if (/\b(election|president|presidential|congress|senate|governor|mayor|policy|government|candidate|campaign)\b/i.test(lower)) {
    return { domain: 'politics', subdomain: /\b(president|presidential|white house)\b/i.test(lower) ? 'political_election_forecasting' : 'politics', answerType, audience: ['political forecaster', 'polling skeptic', 'prediction market reader', 'campaign operator', 'source-quality editor'] };
  }
  if (/\b(stock|stocks|bond|bonds|cash|portfolio|treasury|treasuries|etf|fund|funds|rate|rates|inflation|yield|investment|invest|investor|market|markets)\b/i.test(lower)) {
    return { domain: 'market', subdomain: 'personal-finance', answerType, audience: ['risk manager', 'portfolio builder', 'macro reader', 'cashflow realist', 'investor skeptic'] };
  }
  return { domain: 'general', subdomain: 'general', answerType, audience: ['domain expert', 'skeptical fact-checker', 'practical decision maker', 'curious user', 'counterargument hunter'] };
}

function baseRoute(input, intent, inputKind, primaryQuestion, audience) {
  return {
    intent,
    inputKind,
    input: input.text,
    primaryQuestion,
    audience,
    confidence: input.isShort ? 0.72 : 0.86,
    userBurden: 'one-smart-input',
  };
}
