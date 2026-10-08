const { withAndroidManifest } = require('expo/config-plugins');

// Declares the react-native-background-actions foreground service (Android 14+ requires a type).
module.exports = function withBackgroundActions(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.service = app.service || [];
    const name = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
    if (!app.service.some((s) => s.$['android:name'] === name)) {
      app.service.push({ $: { 'android:name': name, 'android:foregroundServiceType': 'dataSync' } });
    }
    return cfg;
  });
};
