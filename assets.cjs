// Single manifest of served static assets: the server's route map and the
// desktop packaging copy step both read from here. CommonJS so the pkg
// sidecar build can bundle it.
module.exports = {
  publicAssets: {
    '/': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
    '/audio-worklet.js': 'audio-worklet.js',
  },
};
