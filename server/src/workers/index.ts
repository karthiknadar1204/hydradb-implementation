import './ingest-session.worker';
import './enrich-chunk.worker';
import './index-chunk.worker';
import './record-access.worker';
import './retention.worker';
import { retentionQueue } from '../queue/retention';

// Phase 4 — schedule the nightly retention recompute (runs daily at 3 AM).
// Idempotent via fixed jobId; safe to call on every worker startup.
async function scheduleRetentionJob() {
  try {
    await retentionQueue.add(
      'daily-retention-recompute',
      { reason: 'scheduled' },
      {
        repeat: { pattern: '0 3 * * *' },
        jobId: 'retention-daily',
      }
    );
    console.log('[retention] daily recompute scheduled (cron: 0 3 * * *)');
  } catch (err) {
    console.error('[retention] failed to schedule daily job:', err);
  }
}

scheduleRetentionJob();

console.log('All workers started. Press Ctrl+C to shut down.');
