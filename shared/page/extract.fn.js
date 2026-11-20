
function (selector, maxItems, fields, includeEmpty) {
  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  }
  var nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (error) {
    return { error: 'invalid selector: ' + String(error && error.message || error) };
  }
  var items = [];
  for (var index = 0; index < nodes.length && items.length < maxItems; index += 1) {
    var el = nodes[index];
    var item = {};
    if (fields && fields.length > 0) {
      for (var f = 0; f < fields.length; f += 1) {
        var field = fields[f];
        var target = field.selector ? el.querySelector(field.selector) : el;
        var value = '';
        if (target) {
          if (field.attr) {
            value = target.getAttribute(field.attr) || '';
          } else if (
            typeof target.value === 'string' &&
            ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(target.tagName) >= 0
          ) {
            value = target.value;
          } else {
            value = textOf(target);
          }
        }
        item[field.name] = value;
      }
    } else {
      var text = textOf(el);
      if (text) item.text = text;
      if (el.tagName === 'A' && el.href) item.href = el.href;
      if (el.tagName === 'IMG' && el.src) item.src = el.src;
      if (typeof el.value === 'string') item.value = el.value;
    }
    var hasValue = includeEmpty;
    if (!hasValue) {
      for (var key in item) {
        if (Object.prototype.hasOwnProperty.call(item, key) && item[key] !== '' && item[key] != null) {
          hasValue = true;
          break;
        }
      }
    }
    if (hasValue) items.push(item);
  }
  return { url: location.href, matched: nodes.length, returned: items.length, items: items };
}
