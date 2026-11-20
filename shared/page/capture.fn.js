
function (maxChars, selected) {
  var out = [];
  var used = 0;
  var limit = maxChars > 0 ? maxChars : 120000;
  function clean(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }
  function push(line) {
    if (!line || used >= limit) return false;
    var text = line + '\n';
    used += text.length;
    out.push(text);
    return used < limit;
  }
  var root = document.querySelector('article, main, [role="main"]') || document.body;
  var blocks = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote');
  for (var index = 0; index < blocks.length && used < limit; index += 1) {
    var el = blocks[index];
    if (!el || !el.innerText) continue;
    if (el.closest('nav,footer,aside,[aria-hidden="true"]')) continue;
    var tag = el.tagName;
    if (tag === 'LI') {
      push('- ' + clean(el.innerText));
    } else if (tag === 'PRE') {
      push('~~~');
      push(el.innerText.slice(0, 4000));
      push('~~~');
    } else if (tag === 'BLOCKQUOTE') {
      push('> ' + clean(el.innerText));
    } else if (tag.length === 2 && tag[0] === 'H') {
      push('#'.repeat(Number(tag[1])) + ' ' + clean(el.innerText));
    } else {
      push(clean(el.innerText));
    }
  }
  var links = [];
  var anchors = root.querySelectorAll('a[href]');
  for (var index = 0; index < anchors.length && links.length < 60; index += 1) {
    var anchor = anchors[index];
    var href = anchor.href;
    if (!href || href.indexOf('javascript:') === 0) continue;
    links.push({ text: clean(anchor.innerText).slice(0, 120), href: href });
  }
  var description = '';
  var meta = document.querySelector('meta[name="description"],meta[property="og:description"]');
  if (meta) description = meta.getAttribute('content') || '';
  var canonical = document.querySelector('link[rel="canonical"]');
  return {
    title: document.title || '',
    url: location.href,
    canonical: canonical ? canonical.href : '',
    description: description,
    lang: document.documentElement.lang || '',
    text: out.join(''),
    chars: used,
    truncated: used >= limit,
    links: links,
    selected: selected || ''
  };
}
