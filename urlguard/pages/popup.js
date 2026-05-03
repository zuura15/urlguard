let currentTabId = null;

document.getElementById('about-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/about.html') });
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  let pageDomain = '';
  try {
    pageDomain = new URL(tab.url).hostname;
    document.getElementById('page-domain').textContent = pageDomain;
    document.getElementById('site-context-domain').textContent = pageDomain;
  } catch {}

  // Block current page button
  const blockPageBtn = document.getElementById('block-page-btn');
  if (pageDomain && !tab.url.startsWith('chrome://')) {
    const blocked = (await msg('GET_BLOCKED')).blocked;

    const setBlock = () => {
      blockPageBtn.textContent = 'Block this site';
      blockPageBtn.style.color = '#dc2626';
      blockPageBtn.style.borderColor = '#fecaca';
      blockPageBtn.onclick = async () => {
        await msg('BLOCK_DOMAIN', { domain: pageDomain });
        await loadActivity();
        await loadBlocked();
        setUnblock();
      };
    };
    const setUnblock = () => {
      blockPageBtn.textContent = 'Unblock this site';
      blockPageBtn.style.color = '#059669';
      blockPageBtn.style.borderColor = '#a7f3d0';
      blockPageBtn.onclick = async () => {
        await msg('UNBLOCK_DOMAIN', { domain: pageDomain });
        await loadActivity();
        await loadBlocked();
        setBlock();
      };
    };

    blockPageBtn.style.display = 'inline-block';
    if (blocked.includes(pageDomain)) {
      setUnblock();
    } else {
      setBlock();
    }
  }

  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
    };
  });

  await loadActivity();
  await loadBlocked();
  await loadIgnored();
  await loadStats();
}

async function loadStats() {
  const stats = await msg('GET_STATS');
  const el = document.getElementById('total-blocked');
  if (stats.totalBlocked > 0) {
    el.textContent = `— ${stats.totalBlocked} blocked`;
    el.style.display = 'inline';
  }
}

async function loadActivity() {
  const activity = await msg('GET_TAB_ACTIVITY', { tabId: currentTabId });
  const blocked = new Set((await msg('GET_BLOCKED')).blocked);
  const ignored = new Set((await msg('GET_IGNORED')).ignored);

  const list = document.getElementById('events-list');
  const emptyMsg = document.getElementById('empty-msg');
  const blockAllBar = document.getElementById('block-all-bar');
  list.innerHTML = '';

  const events = activity.events || [];

  // Read persistent blocked log (survives worker restarts)
  const blockedLog = (await msg('GET_BLOCKED_LOG')).log || [];

  // Merge persistent blocked log into events
  const blockedEvents = [...(activity.events || []).filter(e => e.type === 'blocked')];
  for (const logEntry of blockedLog) {
    if (!blockedEvents.some(e => e.to === logEntry.to)) {
      blockedEvents.push({ type: 'blocked', from: 'this page', to: logEntry.to, toUrl: logEntry.toUrl, timestamp: logEntry.timestamp });
    }
  }

  // Blocked summary banner
  const blockedSummary = document.getElementById('blocked-summary');
  if (blockedEvents.length > 0) {
    const blockedDomains = [...new Set(blockedEvents.map(e => e.to))];
    blockedSummary.style.display = 'flex';
    document.getElementById('blocked-summary-text').textContent =
      `${blockedEvents.length} request${blockedEvents.length > 1 ? 's' : ''} blocked (${blockedDomains.length} domain${blockedDomains.length > 1 ? 's' : ''})`;
  } else {
    blockedSummary.style.display = 'none';
  }

  // Merge blocked log entries into the events list for tree building
  const allEvents = [...events];
  for (const logEntry of blockedLog) {
    if (!allEvents.some(e => e.type === 'blocked' && e.to === logEntry.to)) {
      allEvents.push({ type: 'blocked', from: 'this page', to: logEntry.to, toUrl: logEntry.toUrl, timestamp: logEntry.timestamp });
    }
  }

  const hasPageDomain = !!getDomain(activity.url) && /^https?:/.test(activity.url || '');
  if (allEvents.length === 0 && !hasPageDomain) {
    emptyMsg.style.display = 'block';
    blockAllBar.style.display = 'none';
    return;
  }
  emptyMsg.style.display = 'none';

  // Build tree
  const pageDomain = getDomain(activity.url);
  const chains = buildChains(allEvents, pageDomain);

  // Always show the current page domain as the first chain so the user can
  // block/allow it inline alongside everything else in the tree.
  if (pageDomain && /^https?:/.test(activity.url || '')) {
    chains.unshift({
      type: 'page',
      nodes: [{ domain: pageDomain, role: 'page' }]
    });
  }

  // Show block-all bar
  const allThirdParty = new Set();
  for (const e of events) {
    if (e.from !== getDomain(activity.url)) allThirdParty.add(e.from);
    allThirdParty.add(e.to);
  }
  const unblockedThirdParty = [...allThirdParty].filter(d => !blocked.has(d));
  if (unblockedThirdParty.length > 0) {
    blockAllBar.style.display = 'flex';
    document.getElementById('activity-count').textContent =
      `${events.length} events, ${unblockedThirdParty.length} domains`;
    document.getElementById('block-all-btn').onclick = async () => {
      for (const domain of unblockedThirdParty) {
        await msg('BLOCK_DOMAIN', { domain });
      }
      await loadActivity();
      await loadBlocked();
    };
  } else {
    blockAllBar.style.display = 'none';
  }

  // Render chains as trees
  for (const chain of chains) {
    const chainDiv = document.createElement('div');
    chainDiv.className = 'tree-chain';

    // Chain header
    const header = document.createElement('div');
    header.className = 'tree-chain-header';
    const typeSpan = document.createElement('span');
    typeSpan.className = 'chain-type ' + chain.type;
    typeSpan.textContent = chain.type === 'redirect' ? 'Redirect chain'
      : chain.type === 'blocked' ? 'Blocked requests'
      : chain.type === 'page' ? 'Current site'
      : 'Background requests';
    header.appendChild(typeSpan);
    if (chain.type !== 'blocked' && chain.nodes.some(n => blocked.has(n.domain))) {
      const badge = document.createElement('span');
      badge.className = 'node-badge blocked';
      badge.textContent = 'BLOCKED';
      header.appendChild(badge);
    }
    if (chain.type === 'blocked') {
      const count = document.createElement('span');
      count.style.cssText = 'font-size:10px;color:#dc2626;font-weight:400;';
      count.textContent = `(${chain.nodes.length - 1} domain${chain.nodes.length > 2 ? 's' : ''})`;
      header.appendChild(count);
    }
    chainDiv.appendChild(header);

    // Tree nodes
    for (let i = 0; i < chain.nodes.length; i++) {
      const node = chain.nodes[i];
      const isFirst = i === 0;
      const isLast = i === chain.nodes.length - 1;
      const isPage = node.domain === getDomain(activity.url);
      const isNodeBlocked = blocked.has(node.domain);

      const nodeDiv = document.createElement('div');
      nodeDiv.className = 'tree-node';

      if (!isFirst && !isLast) {
        const connector = document.createElement('div');
        connector.className = 'tree-connector';
        nodeDiv.appendChild(connector);
      }

      const content = document.createElement('span');
      content.className = 'node-content';

      // Arrow prefix for non-first nodes
      if (!isFirst) {
        const arrow = document.createElement('span');
        arrow.style.cssText = 'color:#d1d5db;font-size:11px;';
        arrow.textContent = '↳ ';
        content.appendChild(arrow);
      }

      const isAllowed = ignored.has(node.domain);
      const domainSpan = document.createElement('span');
      domainSpan.className = 'node-domain' + (isPage ? ' is-page' : ' is-third-party') + (isNodeBlocked ? ' node-blocked' : '') + (isAllowed ? ' is-allowed' : '');
      domainSpan.textContent = node.domain;
      content.appendChild(domainSpan);

      if (node.role) {
        const roleBadge = document.createElement('span');
        roleBadge.className = 'node-badge initiator';
        roleBadge.textContent = node.role;
        content.appendChild(roleBadge);
      }

      // Show how this hop was reached (HTTP redirect / JS / meta-refresh).
      if (node.kind && node.kind !== 'start' && node.kind !== 'committed') {
        const kindBadge = document.createElement('span');
        kindBadge.className = 'node-badge kind';
        kindBadge.textContent = node.kind === 'http' ? 'HTTP'
          : node.kind === 'client' ? 'JS'
          : node.kind;
        content.appendChild(kindBadge);
      }

      if (isNodeBlocked) {
        const blockedBadge = document.createElement('span');
        blockedBadge.className = 'node-badge blocked';
        blockedBadge.textContent = 'BLOCKED';
        content.appendChild(blockedBadge);
      }

      // Inline actions — show on any non-blocked, non-page node (or page domain
      // for background-request and page-domain chains).
      if (!isNodeBlocked && (!isPage || chain.type === 'background' || chain.type === 'page')) {
        const inlineActions = document.createElement('span');
        inlineActions.className = 'node-hover-actions';

        const blockBtn = document.createElement('button');
        blockBtn.className = 'h-block';
        blockBtn.textContent = '✕';
        blockBtn.title = 'Block ' + node.domain;
        blockBtn.onclick = async (e) => {
          e.stopPropagation();
          await msg('BLOCK_DOMAIN', { domain: node.domain });
          await loadActivity();
          await loadBlocked();
        };
        inlineActions.appendChild(blockBtn);

        const ignoreBtn = document.createElement('button');
        ignoreBtn.className = 'h-ignore' + (isAllowed ? ' is-allowed' : '');
        ignoreBtn.textContent = '✓';
        ignoreBtn.title = isAllowed ? 'Remove from allowed list' : 'Allow ' + node.domain;
        ignoreBtn.onclick = async (e) => {
          e.stopPropagation();
          if (isAllowed) {
            await msg('UNIGNORE_DOMAIN', { domain: node.domain });
          } else {
            await msg('IGNORE_DOMAIN', { domain: node.domain });
          }
          await loadActivity();
        };
        inlineActions.appendChild(ignoreBtn);

        content.appendChild(inlineActions);
      }

      nodeDiv.appendChild(content);
      chainDiv.appendChild(nodeDiv);
    }

    list.appendChild(chainDiv);
  }
}

function buildChains(events, pageDomain) {
  // Group redirect events into chains: follow from → to links
  // Background events group by initiator domain

  const chainEvents = events.filter(e => e.type === 'redirect_chain');
  const redirectEvents = events.filter(e => e.type === 'redirect');
  const backgroundEvents = events.filter(e => e.type === 'background');
  const blockedEvents = events.filter(e => e.type === 'blocked');

  const chains = [];

  // Prefer the canonical redirect_chain events emitted by the service worker.
  // Each one already carries every hop (HTTP, client, meta) for one navigation,
  // so we can render it as a single tree without lossy pairwise reassembly.
  const subsumedPairs = new Set();
  for (const ev of chainEvents) {
    if (!ev.hops || ev.hops.length < 2) continue;
    const nodes = [];
    let prevDomain = null;
    for (const hop of ev.hops) {
      const domain = hop.domain || (hop.url ? getDomain(hop.url) : null);
      if (!domain) continue;
      // Collapse consecutive identical-domain hops into one node, keeping the
      // first hop's kind (a same-domain HTTP redirect followed by a commit
      // shouldn't render two stacked rows for the same host).
      if (nodes.length === 0 || nodes[nodes.length - 1].domain !== domain) {
        nodes.push({ domain, role: null, kind: hop.kind });
      }
      if (prevDomain && prevDomain !== domain) {
        subsumedPairs.add(prevDomain + '→' + domain);
      }
      prevDomain = domain;
    }
    if (nodes.length >= 2) {
      chains.push({ type: 'redirect', nodes });
    }
  }

  // Build redirect chains by following from → to links
  const used = new Set();
  // Skip legacy single-hop redirect events that are already represented
  // inside a redirect_chain we just rendered.
  for (const ev of redirectEvents) {
    if (subsumedPairs.has(ev.from + '→' + ev.to)) used.add(ev);
  }
  for (const event of redirectEvents) {
    if (used.has(event)) continue;

    // Find the start of this chain (walk backwards via from)
    let start = event;
    for (const other of redirectEvents) {
      if (other.to === start.from && !used.has(other)) {
        start = other;
      }
    }

    // Now walk forward from start
    const nodes = [];
    const initiator = start.initiator ? getDomain(start.initiator) : null;

    if (initiator && initiator !== start.from && initiator !== pageDomain) {
      nodes.push({ domain: initiator, role: 'initiator' });
    }

    let current = start;
    const visited = new Set();
    while (current && !visited.has(current.from + '→' + current.to)) {
      visited.add(current.from + '→' + current.to);
      used.add(current);

      if (nodes.length === 0 || nodes[nodes.length - 1].domain !== current.from) {
        nodes.push({ domain: current.from, role: null });
      }
      nodes.push({ domain: current.to, role: null });

      // Find next hop: where current.to === next.from
      current = redirectEvents.find(e => !used.has(e) && e.from === current.to);
    }

    if (nodes.length > 0) {
      chains.push({ type: 'redirect', nodes });
    }
  }

  // Group background events by initiator
  const bgByInitiator = {};
  for (const event of backgroundEvents) {
    const key = event.initiator ? getDomain(event.initiator) : event.from;
    if (!bgByInitiator[key]) bgByInitiator[key] = [];
    bgByInitiator[key].push(event);
  }

  for (const [initiator, bgEvents] of Object.entries(bgByInitiator)) {
    const nodes = [{ domain: initiator, role: initiator !== pageDomain ? 'initiator' : 'page' }];
    for (const e of bgEvents) {
      if (e.to !== initiator) {
        nodes.push({ domain: e.to, role: null });
      }
    }
    if (nodes.length > 1) {
      chains.push({ type: 'background', nodes });
    }
  }

  // Group blocked events
  if (blockedEvents.length > 0) {
    const blockedNodes = [{ domain: pageDomain || 'this page', role: 'page' }];
    const seen = new Set();
    for (const e of blockedEvents) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        blockedNodes.push({ domain: e.to, role: null });
      }
    }
    if (blockedNodes.length > 1) {
      chains.unshift({ type: 'blocked', nodes: blockedNodes });
    }
  }

  return chains;
}

async function loadBlocked() {
  const blocked = (await msg('GET_BLOCKED')).blocked;
  const list = document.getElementById('blocked-list');
  const emptyMsg = document.getElementById('blocked-empty');
  list.innerHTML = '';

  if (blocked.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  for (const domain of blocked) {
    const div = document.createElement('div');
    div.className = 'list-item';

    const name = document.createElement('span');
    name.className = 'list-domain';
    name.textContent = domain;
    div.appendChild(name);

    const actions = document.createElement('span');
    actions.className = 'hover-actions';

    const unblockBtn = document.createElement('button');
    unblockBtn.className = 'btn-unblock';
    unblockBtn.textContent = 'Unblock';
    unblockBtn.onclick = async () => {
      await msg('UNBLOCK_DOMAIN', { domain });
      await reloadAll();
    };
    actions.appendChild(unblockBtn);

    const allowBtn = document.createElement('button');
    allowBtn.className = 'btn-remove';
    allowBtn.textContent = 'Allow';
    allowBtn.title = 'Unblock and add to allowed list';
    allowBtn.onclick = async () => {
      await msg('UNBLOCK_DOMAIN', { domain });
      await msg('IGNORE_DOMAIN', { domain });
      await reloadAll();
    };
    actions.appendChild(allowBtn);

    div.appendChild(actions);
    list.appendChild(div);
  }
}

async function loadIgnored() {
  const ignored = (await msg('GET_IGNORED')).ignored;
  const list = document.getElementById('ignored-list');
  const emptyMsg = document.getElementById('ignored-empty');
  list.innerHTML = '';

  if (ignored.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  for (const domain of ignored) {
    const div = document.createElement('div');
    div.className = 'list-item';

    const name = document.createElement('span');
    name.className = 'list-domain';
    name.textContent = domain;
    div.appendChild(name);

    const actions = document.createElement('span');
    actions.className = 'hover-actions';

    const blockBtn = document.createElement('button');
    blockBtn.className = 'btn-block';
    blockBtn.textContent = 'Block';
    blockBtn.onclick = async () => {
      await msg('BLOCK_DOMAIN', { domain });
      await reloadAll();
    };
    actions.appendChild(blockBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.title = 'Remove from allowed list (will show in activity again)';
    removeBtn.onclick = async () => {
      await msg('UNIGNORE_DOMAIN', { domain });
      await reloadAll();
    };
    actions.appendChild(removeBtn);

    div.appendChild(actions);
    list.appendChild(div);
  }
}

async function reloadAll() {
  await loadActivity();
  await loadBlocked();
  await loadIgnored();
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

function msg(type, data) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...data }, resolve);
  });
}

init();
