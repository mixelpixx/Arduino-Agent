// When running in development mode, do not webpack the backend and electron main modules.
// It does not work in watch mode: https://github.com/eclipse-theia/theia/issues/12793.
const configs = require('./webpack.config');
const [mainWindowConfig, preloadConfig] = configs;

module.exports = [mainWindowConfig, preloadConfig];
