const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '../content/popup-guard-main.js'),
  'utf8'
);

// URLs the live GIS client passes to window.open (accounts.google.com/gsi/client).
const GIS_SELECT = 'https://accounts.google.com/gsi/select?client_id=example.apps.googleusercontent.com&ux_mode=popup';
const GIS_OAUTH = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example.apps.googleusercontent.com&redirect_uri=gis_transform&response_mode=form_post&scope=openid%20email%20profile&response_type=id_token&gsiwebsdk=gis_attributes&display=popup';
const CLASSIC_OAUTH = 'https://accounts.google.com/o/oauth2/auth?client_id=example.apps.googleusercontent.com&response_type=token&redirect_uri=https%3A%2F%2Fyoga.argeon.ai%2Fcallback';

function createEventTarget() {
  const map = new Map();
  return {
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of map.get(ev.type) || []) fn(ev);
      return true;
    }
  };
}

function CustomEvent(type, init) {
  this.type = type;
  this.detail = init && init.detail;
}

/**
 * Load the MAIN-world popup guard against a stub page and return the wrapped
 * window.open plus any popup reports it emitted.
 */
function loadGuard(options = {}) {
  const hostname = options.hostname || 'yoga.argeon.ai';
  const href = options.href || 'https://yoga.argeon.ai/';
  const embed = !!options.embed;
  const popups = [];
  const document = createEventTarget();
  document.getElementsByTagName = (tag) => {
    if (embed && tag === 'video') {
      return [{
        getBoundingClientRect: () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 })
      }];
    }
    return [];
  };
  const nativeOpen = vi.fn(() => ({ closed: false }));
  const window = createEventTarget();
  window.document = document;
  window.location = { hostname, href };
  window.open = nativeOpen;
  window.CustomEvent = CustomEvent;
  window.parent = window;
  window.top = embed ? {} : window;
  window.__incontrolGesture = null;

  const realDispatch = document.dispatchEvent;
  document.dispatchEvent = (ev) => {
    if (ev.type === 'incontrol:popup') popups.push(JSON.parse(ev.detail));
    return realDispatch(ev);
  };

  const context = vm.createContext({
    window,
    document,
    location: window.location,
    CustomEvent,
    URL,
    console
  });
  vm.runInContext('class Element {}', context);
  vm.runInContext(SCRIPT, context);

  function configure(cfg) {
    document.dispatchEvent(new CustomEvent('incontrol:config', {
      detail: JSON.stringify({
        enabled: true,
        blockAll: true,
        blocked: [],
        allowed: [],
        ...cfg
      })
    }));
  }

  function anchor(href) {
    return vm.runInContext(
      `(() => {
        const a = new Element();
        a.href = ${JSON.stringify(href)};
        a.closest = (sel) => (sel === 'a[href]' ? a : null);
        a.querySelector = () => null;
        a.replaceWith = () => {};
        return a;
      })()`,
      context
    );
  }

  function click(href, { trusted = false } = {}) {
    const event = {
      type: 'click',
      target: anchor(href),
      isTrusted: trusted,
      clientX: 10,
      clientY: 10,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn()
    };
    window.dispatchEvent(event);
    return event;
  }

  return { window, nativeOpen, popups, configure, click };
}

function opened(guard) {
  return guard.nativeOpen.mock.calls.map(call => call[0]);
}

describe('popup guard Google sign-in exception', () => {
  it('allows GIS and classic Google OAuth popups under default block-all', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });

    for (const url of [GIS_SELECT, GIS_OAUTH, CLASSIC_OAUTH]) {
      const win = guard.window.open(url, 'g_credential_picker', 'width=500,height=600');
      expect(win).not.toBeNull();
    }

    expect(opened(guard)).toEqual([GIS_SELECT, GIS_OAUTH, CLASSIC_OAUTH]);
    expect(guard.popups).toEqual([]);
  });

  it('allows a future path on accounts.google.com and a mixed-case host', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });
    const future = 'https://accounts.google.com/gsi/future-picker?ux_mode=popup';
    const mixed = 'https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth?display=popup';
    expect(guard.window.open(future)).not.toBeNull();
    expect(guard.window.open(mixed)).not.toBeNull();
    expect(guard.popups).toEqual([]);
  });

  it('still cancels ad and other Google popups under block-all', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });
    const blocked = [
      'https://ads.example/popunder',
      'https://www.google.com/search?q=deal',
      'https://www.google.com/o/oauth2/v2/auth?display=popup',
      'https://mail.google.com/',
      'https://www.youtube.com/watch?v=ad',
      'https://ad.doubleclick.net/ddm/clk/123',
      'https://pagead2.googlesyndication.com/pagead/ads',
      'https://accounts.google.com.evil.test/gsi/select',
      'https://evil.accounts.google.com/gsi/select',
      'about:blank'
    ];
    for (const url of blocked) {
      expect(guard.window.open(url, '_blank'), url).toBeNull();
    }
    expect(opened(guard)).toEqual([]);
    expect(guard.popups.every(p => p.action === 'blocked' && p.reason === 'block-all')).toBe(true);
    expect(guard.popups).toHaveLength(blocked.length);
  });

  it('lets an explicit Block of accounts.google.com win', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true, blocked: ['accounts.google.com'] });
    expect(guard.window.open(GIS_SELECT)).toBeNull();
    expect(opened(guard)).toEqual([]);
    expect(guard.popups).toEqual([
      expect.objectContaining({ action: 'blocked', reason: 'blocked-domain', host: 'accounts.google.com' })
    ]);
  });

  it('does not treat a Google auth popup as a link hijack or a video popunder', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: false });
    guard.window.__incontrolGesture = { t: Date.now(), media: false, fpLink: true };
    expect(guard.window.open(GIS_OAUTH)).not.toBeNull();
    expect(guard.window.open('https://pop.example/from-pager')).toBeNull();

    guard.window.__incontrolGesture = { t: Date.now(), media: true, fpLink: false };
    expect(guard.window.open(GIS_SELECT)).not.toBeNull();
    expect(guard.window.open('https://pop.example/from-video')).toBeNull();

    const reasons = guard.popups.map(p => p.reason);
    expect(reasons).toEqual(['link-hijack', 'video-click']);
    expect(opened(guard)).toEqual([GIS_OAUTH, GIS_SELECT]);
  });

  it('does not treat a Google auth popup from a video embed frame as an ad', () => {
    const guard = loadGuard({ embed: true });
    guard.configure({ blockAll: false });
    guard.window.__incontrolGesture = { t: Date.now(), media: false, fpLink: false };
    expect(guard.window.open(CLASSIC_OAUTH)).not.toBeNull();
    expect(guard.window.open('https://pop.example/embed-ad')).toBeNull();
    expect(guard.popups.map(p => p.reason)).toEqual(['video-embed']);
  });

  it('still honors the user Allowed list and still reports other third-party opens', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true, allowed: ['pay.example'] });
    expect(guard.window.open('https://pay.example/checkout')).not.toBeNull();
    expect(guard.popups).toEqual([]);

    const loose = loadGuard();
    loose.configure({ blockAll: false });
    expect(loose.window.open('https://cdn.example/widget')).not.toBeNull();
    expect(loose.window.open(GIS_SELECT)).not.toBeNull();
    expect(loose.popups).toEqual([
      expect.objectContaining({ action: 'opened', reason: 'third-party', host: 'cdn.example' })
    ]);
  });

  it('leaves same-site opens and a disabled guard alone', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });
    expect(guard.window.open('https://yoga.argeon.ai/dashboard')).not.toBeNull();
    expect(guard.window.open('/settings')).not.toBeNull();

    const off = loadGuard();
    off.configure({ enabled: false, blockAll: true });
    expect(off.window.open('https://ads.example/pop')).not.toBeNull();
    expect(off.popups).toEqual([]);
  });

  it('cancels a video popunder link, and leaves a Google auth link alone', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });
    guard.window.__incontrolGesture = { t: Date.now(), media: true, fpLink: false };

    const ad = guard.click('https://ads.example/click');
    expect(ad.preventDefault).toHaveBeenCalled();
    expect(guard.popups.map(p => p.reason)).toEqual(['synthetic-click']);

    const google = guard.click('https://accounts.google.com/o/oauth2/v2/auth?display=popup');
    expect(google.preventDefault).not.toHaveBeenCalled();

    const otherGoogle = guard.click('https://www.google.com/aclk?sa=l');
    expect(otherGoogle.preventDefault).toHaveBeenCalled();

    const blockedGoogle = loadGuard();
    blockedGoogle.configure({ blocked: ['accounts.google.com'] });
    const blocked = blockedGoogle.click(GIS_SELECT);
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(blockedGoogle.popups[0].reason).toBe('blocked-domain');
  });

  it('does not cancel an ordinary third-party link click when block-all is on', () => {
    const guard = loadGuard();
    guard.configure({ blockAll: true });
    const link = guard.click('https://partner.example/go', { trusted: true });
    expect(link.preventDefault).not.toHaveBeenCalled();
    expect(guard.popups).toEqual([]);
  });
});
