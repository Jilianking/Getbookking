/**
 * ChatGPT Ads measurement pixel (OpenAI oaiq SDK).
 * https://developers.openai.com/ads/measurement-pixel
 */
!(function (w, d, s, u) {
  if (w.oaiq) return;
  var q = function () {
    q.q.push(arguments);
  };
  q.q = [];
  w.oaiq = q;
  var j = d.createElement(s);
  j.async = 1;
  j.src = u;
  var f = d.getElementsByTagName(s)[0];
  f.parentNode.insertBefore(j, f);
})(window, document, "script", "https://bzrcdn.openai.com/sdk/oaiq.min.js");

oaiq("init", { pixelId: "Hq1QRMn1nHgCjhGbki399G" });
