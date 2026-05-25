// Sentry init — MUST be the very first thing required in app.js so its
// auto-instrumentation can hook into HTTP, Express, etc. as they load.
//
// No-op when SENTRY_DSN is not set, so local dev and tests don't need it.

if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn:             process.env.SENTRY_DSN,
    environment:     process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
    release:         process.env.RAILWAY_DEPLOYMENT_ID || undefined,
    tracesSampleRate: 0.1,
    sendDefaultPii:   false,
  });
  console.log('[Sentry] Initialised');
} else {
  console.log('[Sentry] SENTRY_DSN not set — error reporting disabled');
}

// Always export the SDK so the rest of the code can call captureException
// without checking whether DSN was provided. When DSN is missing the SDK
// becomes a no-op shell — captureException is safe to call regardless.
module.exports = require('@sentry/node');
