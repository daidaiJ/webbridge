
function (action, clear) {
  var KEY = '__webbridgeConsole';
  var HOOKED = '__webbridgeConsoleHooked';

  function serialize(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  }

  function push(level, args) {
    var log = window[KEY];
    if (!log) return;
    var text = '';
    try {
      text = Array.prototype.map.call(args, serialize).join(' ');
    } catch (error) {
      text = String(error);
    }
    log.push({ at: Date.now(), level: level, text: text.slice(0, 500) });
    if (log.length > 200) log.shift();
  }

  if (action === 'start') {
    if (!window[KEY]) window[KEY] = [];
    if (!window[HOOKED]) {
      window[HOOKED] = true;
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var original = console[level];
        console[level] = function () {
          push(level, arguments);
          return original.apply(console, arguments);
        };
      });
      window.addEventListener('error', function (event) {
        push('error', [event.message + ' @ ' + event.filename + ':' + event.lineno]);
      });
      window.addEventListener('unhandledrejection', function (event) {
        push('error', ['unhandled rejection: ' + (event.reason && event.reason.message || event.reason)]);
      });
    }
    return { started: true, count: window[KEY].length };
  }

  if (action === 'stop') {
    delete window[KEY];
    return { stopped: true };
  }

  var log = window[KEY] || [];
  var messages = log.slice(-100);
  if (clear) log.length = 0;
  return { url: location.href, count: log.length, messages: messages };
}
