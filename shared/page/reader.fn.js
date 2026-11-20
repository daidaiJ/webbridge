
function (maxChars) {
  var limit = maxChars > 0 ? maxChars : 60000;
  var DROP = 'script,style,noscript,iframe,svg,canvas,form,input,button,select,textarea,' +
    'nav,aside,footer,header,[aria-hidden="true"],[hidden],[role="navigation"],[role="banner"],' +
    '[role="contentinfo"],[role="complementary"],[role="search"]';
  var POSITIVE = /article|body|content|entry|hentry|main|page|post|text|blog|story|prose|markdown/i;
  var NEGATIVE = /comment|combx|contact|foot|footer|header|menu|meta|nav|rss|share|shoutbox|sidebar|sponsor|ad-|ads|promo|related|social|subscribe|cookie|banner|modal|popup|toolbar|reference|reflist|navbox|infobox|catlinks|printfooter|editsection|hatnote|ambox|mbox|sistersitebox|noprint|toc/i;
  var HINT_ROOT = '#mw-content-text,.mw-parser-output,main,[role="main"],.post,.entry,.article,.content,.markdown-body,#content,article';

  function clean(value) {
    return (value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Work on a clone so the live page never changes.
  var root = document.querySelector(HINT_ROOT) || document.body;
  var clone = root.cloneNode(true);
  var dropped = 0;
  var nodes = clone.querySelectorAll(DROP);
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (node.parentNode) {
      node.parentNode.removeChild(node);
      dropped += 1;
    }
  }

  // Remove boilerplate by class/id, but keep containers that also carry a
  // strong content hint (e.g. "post-content").
  var marked = clone.querySelectorAll('[class],[id]');
  for (var m = 0; m < marked.length; m += 1) {
    var marker = String(marked[m].className || '') + ' ' + String(marked[m].id || '');
    if (NEGATIVE.test(marker) && !POSITIVE.test(marker) && marked[m].parentNode) {
      marked[m].parentNode.removeChild(marked[m]);
      dropped += 1;
    }
  }

  function weightOf(element) {
    if (!element || element.nodeType !== 1) return 0;
    var marker = String(element.className || '') + ' ' + String(element.id || '');
    var weight = 0;
    if (POSITIVE.test(marker)) weight += 25;
    if (NEGATIVE.test(marker)) weight -= 25;
    if (/(reference|reflist|navbox|infobox|catlinks|printfooter|editsection|toc)/i.test(marker)) weight -= 100;
    if (element.tagName === 'ARTICLE' || element.tagName === 'MAIN') weight += 25;
    return weight;
  }

  // A blog index or a search page has several small article cards. Returning
  // one card is worse than returning a clean digest of the listing.
  var cards = clone.querySelectorAll('article');
  var longestCard = 0;
  for (var c = 0; c < cards.length; c += 1) {
    longestCard = Math.max(longestCard, clean(cards[c].textContent).length);
  }
  // A long paragraph means this is an article page with related cards, not a
  // listing page. Only listing pages get the digest.
  var longestParagraph = 0;
  var checkParagraphs = clone.querySelectorAll('p');
  for (var cp = 0; cp < checkParagraphs.length; cp += 1) {
    longestParagraph = Math.max(longestParagraph, clean(checkParagraphs[cp].textContent).length);
  }
  if (cards.length >= 4 && longestCard < 1500 && longestParagraph < 400) {
    var digest = [];
    for (var d = 0; d < cards.length && digest.join('\n').length < limit; d += 1) {
      var card = cards[d];
      var heading = card.querySelector('h1,h2,h3,h4');
      var link = card.querySelector('a[href]');
      var paragraph = card.querySelector('p');
      var headingText = clean(heading ? heading.textContent : link ? link.textContent : '');
      if (!headingText) continue;
      digest.push('## ' + headingText);
      if (link && link.href) digest.push('<' + link.href + '>');
      var snippet = clean(paragraph ? paragraph.textContent : card.textContent).slice(0, 240);
      if (snippet) digest.push(snippet);
      digest.push('');
    }
    if (digest.length > 0) {
      var listingText = digest.join('\n').trim();
      return {
        url: location.href,
        title: clean(document.title),
        byline: '',
        published: '',
        text: listingText.slice(0, limit),
        chars: Math.min(listingText.length, limit),
        truncated: listingText.length > limit,
        dropped: dropped,
        score: 0,
        candidates: cards.length,
        listing: true
      };
    }
  }

  // Reader-mode scoring: text length plus commas, accumulated up the parents.
  var scores = new Map();
  var paragraphs = clone.querySelectorAll('p,pre,blockquote,li,td');
  for (var p = 0; p < paragraphs.length; p += 1) {
    var text = clean(paragraphs[p].textContent);
    if (text.length < 25) continue;
    var score = 1 + (text.match(/,|，/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
    var current = paragraphs[p];
    for (var depth = 0; current && depth < 5; depth += 1) {
      if (current.nodeType !== 1) break;
      var base = scores.get(current) || 0;
      var addition = depth === 0 ? score : score / (depth * 2);
      scores.set(current, base + addition + (depth === 0 ? weightOf(current) : 0));
      current = current.parentElement;
    }
  }

  var best = null;
  var bestScore = 0;
  scores.forEach(function (score, element) {
    if (element.tagName === 'BODY' || element.tagName === 'HTML') return;
    if (score > bestScore) {
      bestScore = score;
      best = element;
    }
  });
  if (!best) best = clone.querySelector(HINT_ROOT) || clone;

  // Keep the winning container plus strong siblings; that is what removes
  // "related posts" and sidebar fragments that survived the class filters.
  var container = best;
  var parent = best.parentElement;
  if (parent) {
    var assembled = parent.cloneNode(false);
    var siblings = parent.children;
    for (var s = 0; s < siblings.length; s += 1) {
      var sibling = siblings[s];
      var siblingScore = scores.get(sibling) || 0;
      if (sibling === best || siblingScore >= Math.max(10, bestScore * 0.2)) {
        assembled.appendChild(sibling.cloneNode(true));
      }
    }
    container = assembled;
  }

  var out = [];
  var used = 0;
  function push(line) {
    if (!line || used >= limit) return;
    var piece = line + '\n';
    used += piece.length;
    out.push(piece);
  }

  function inline(element) {
    return clean(element.textContent);
  }

  function walk(element) {
    if (used >= limit || !element) return;
    if (element.nodeType === 1 && element !== container) {
      var marker = String(element.className || '') + ' ' + String(element.id || '');
      if (NEGATIVE.test(marker) && !POSITIVE.test(marker)) return;
    }
    if (element.nodeType === 3) {
      var text = clean(element.textContent);
      if (text) push(text);
      return;
    }
    if (element.nodeType !== 1) return;
    var tag = element.tagName;
    if (tag === 'A') {
      var label = inline(element);
      if (label) push(label);
      return;
    }
    if (tag === 'IMG') {
      // Alt text is often an infobox caption or a duplicate of a figure
      // caption; keep the prose clean and skip it.
      return;
    }
    if (tag === 'PRE') {
      push('~~~');
      push(element.textContent.replace(/\s+$/, '').slice(0, 8000));
      push('~~~');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      push('> ' + inline(element));
      return;
    }
    if (tag === 'LI') {
      push('- ' + inline(element));
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      var level = Number(tag[1]);
      push('#'.repeat(level) + ' ' + inline(element));
      return;
    }
    if (tag === 'HR') {
      push('---');
      return;
    }
    if (tag === 'P' || tag === 'TD' || tag === 'TH' || tag === 'FIGCAPTION' || tag === 'DD' || tag === 'DT') {
      var body = inline(element);
      if (body) push(body);
      return;
    }
    if ((tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN') && element.textContent.length < 60) {
      var shortText = inline(element);
      if (shortText) push(shortText);
      return;
    }
    var children = element.childNodes;
    for (var c = 0; c < children.length; c += 1) walk(children[c]);
  }

  var blocks = container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,blockquote,li,figcaption,hr,img');
  if (blocks.length === 0) {
    walk(container);
  } else {
    // Walk the container but only emit block-level output, so nested
    // structures do not repeat their text.
    var emitted = new Set();
    for (var b = 0; b < blocks.length && used < limit; b += 1) {
      var block = blocks[b];
      var ancestor = block.parentElement;
      var skip = false;
      while (ancestor && ancestor !== container) {
        if (emitted.has(ancestor)) {
          skip = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (skip) continue;
      emitted.add(block);
      walk(block);
    }
  }

  var byline = '';
  var author = document.querySelector('[rel="author"],.author,.byline,[itemprop="author"]');
  if (author) byline = clean(author.textContent).slice(0, 120);
  var published = document.querySelector('time[datetime],meta[property="article:published_time"]');
  var date = published
    ? published.getAttribute('datetime') || published.getAttribute('content') || ''
    : '';

  return {
    url: location.href,
    title: clean((document.querySelector('h1') || {}).textContent || document.title || ''),
    byline: byline,
    published: date,
    text: out.join('').replace(/\n{3,}/g, '\n\n').trim(),
    chars: used,
    truncated: used >= limit,
    dropped: dropped,
    score: Math.round(bestScore),
    candidates: scores.size
  };
}
