// The shared helper supplies nonce verification and protected, no-overwrite
// persistence. This entry point never starts the ordinary live consumer.
const usage = 'Usage: node scripts/pair-owner.js --app-credentials-file ABSOLUTE_JSON --output ABSOLUTE_JSON --confirm-stopped --confirm-private-storage';
const args = process.argv.slice(2);
if (args.length !== 6 || !args.includes('--confirm-stopped') || !args.includes('--confirm-private-storage')) {
  process.stdout.write(`${usage}\nNo private files were read. Stop all existing consumers before pairing.\n`);
  process.exitCode = 2;
} else {
  try {
    const values = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--confirm-stopped', '--confirm-private-storage'].includes(arg)) continue;
      if (!['--app-credentials-file', '--output'].includes(arg) || values[arg] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error();
      values[arg] = args[++index];
    }
    if (!values['--app-credentials-file'] || !values['--output']) throw new Error();
    const { readPrivateFile } = await import('@dot-bridge/core/platform/private-files.js');
    const { assertPairingDestination, createOwnerPairing, writePairedCredentials } = await import('@dot-bridge/core/channels/pairing.js');
    const { createEnrollmentProvider } = await import('../src/provider.js');
    assertPairingDestination(values['--output']);
    const bytes = readPrivateFile(values['--app-credentials-file'], { maxBytes: 16_384 });
    let credentials;
    try { credentials = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
        Object.keys(credentials).some(key => !['clientId', 'clientSecret', 'robotCode', 'corpId'].includes(key))) throw new Error();
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const pairing = createOwnerPairing({ credentials, confirmStopped: true, createEnrollmentProvider, signal: controller.signal });
      process.stdout.write(`Open your own private chat with this DingTalk robot and send this exact phrase within five minutes:\n${pairing.phrase}\n`);
      const identity = await pairing.waitForOwner();
      writePairedCredentials(values['--output'], { ...credentials, ...identity });
      process.stdout.write('Owner verified. Protected credentials saved. Pairing stopped; configure the live service and original dot subscription next.\n');
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch { process.stderr.write('Pairing did not complete. Check the flags, private paths, application credentials and robot availability. Existing credentials were not replaced.\n'); process.exitCode = 1; }
}
