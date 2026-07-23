export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('uncaughtException', (err) => {
      console.error('[Server Instrumentation] Global Uncaught Exception:', err);
    });
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Server Instrumentation] Global Unhandled Rejection at:', promise, 'reason:', reason);
    });
  }
}
