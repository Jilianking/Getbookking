// Loads videos marked data-lazy only when they get close to the screen,
// so visitors who never scroll to a video never download it.
(function () {
  var videos = document.querySelectorAll("video[data-lazy]");
  if (!videos.length) return;

  function load(video) {
    if (video.dataset.loaded) return;
    video.dataset.loaded = "1";
    video.querySelectorAll("source[data-src]").forEach(function (source) {
      source.src = source.dataset.src;
    });
    video.preload = "auto";
    video.load();
    var playing = video.play();
    if (playing && playing.catch) playing.catch(function () {});
  }

  if (!("IntersectionObserver" in window)) {
    videos.forEach(load);
    return;
  }

  // Start loading well before the video scrolls into view.
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          load(entry.target);
        }
      });
    },
    { rootMargin: "800px 0px" }
  );
  videos.forEach(function (video) {
    observer.observe(video);
  });
})();
