import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ParticipantModel, TripModel } from '../models/index.js';
import { supportsTransactions } from '../services/atomicWrite.js';
import {
  activeLinkedOrganizerFilter,
  countActiveLinkedOrganizers,
} from '../services/organizerInvariant.js';
import { clearTestEmailOutbox, getTestEmailOutbox } from '../services/emailService.js';

const STANDALONE_TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_sole_organizer_invariant';

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveMongodExecutable(): string {
  const envMongod = process.env.MONGOD_PATH?.trim();
  if (envMongod) {
    if (!isExecutableFile(envMongod)) {
      throw new Error(
        `Replica-set test cannot run: MONGOD_PATH is set to "${envMongod}", but no executable was found there.`
      );
    }
    return envMongod;
  }

  const candidateNames =
    process.platform === 'win32' ? ['mongod.exe', 'mongod.cmd', 'mongod'] : ['mongod'];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe',
          'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
          'C:\\Program Files\\MongoDB\\Server\\6.0\\bin\\mongod.exe',
        ]
      : [
          '/usr/bin/mongod',
          '/usr/local/bin/mongod',
          '/opt/homebrew/bin/mongod',
          '/opt/mongodb/bin/mongod',
        ];

  for (const candidate of fallbackCandidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Replica-set transaction test requires either TEST_REPLICA_SET_URI (or MONGODB_REPLICA_URI), MONGOD_PATH, or mongod in PATH.'
  );
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate ephemeral port.')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function startOrConnectReplicaSet(): Promise<{ cleanup: () => Promise<void> }> {
  const externalUri =
    process.env.TEST_REPLICA_SET_URI?.trim() || process.env.MONGODB_REPLICA_URI?.trim();

  if (externalUri) {
    await disconnectDatabase();
    let hasDbName = false;
    try {
      const parsedUrl = new URL(externalUri);
      hasDbName = parsedUrl.pathname.length > 1;
    } catch {
      hasDbName = /\/[^/?]+/.test(externalUri.replace(/^[a-zA-Z+]+:\/\//, ''));
    }

    await mongoose.connect(externalUri, {
      serverSelectionTimeoutMS: 5000,
      ...(hasDbName ? {} : { dbName: 'tripledger_test_sole_org_replset' }),
    });

    if (!(await supportsTransactions())) {
      await disconnectDatabase();
      throw new Error(
        'Configured TEST_REPLICA_SET_URI / MONGODB_REPLICA_URI does not support transactions.'
      );
    }

    await mongoose.connection.db!.dropDatabase();
    return {
      cleanup: async () => {
        try {
          if (mongoose.connection.db) {
            await mongoose.connection.db.dropDatabase();
          }
        } finally {
          await disconnectDatabase();
        }
      },
    };
  }

  const mongodPath = resolveMongodExecutable();
  const replPort = await allocateEphemeralPort();
  const replDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-org-'));
  let replProc: ChildProcess | null = null;
  let spawnStderr = '';

  const cleanupLocal = async () => {
    await disconnectDatabase();
    if (replProc) {
      if (replProc.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          replProc?.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          replProc?.kill();
        });
      }
      replProc = null;
    }
    try {
      fs.rmSync(replDbDir, { recursive: true, force: true });
    } catch {
      // ignore delayed Windows file handle release
    }
  };

  try {
    await disconnectDatabase();
    replProc = spawn(
      mongodPath,
      [
        '--replSet',
        'rs0',
        '--port',
        String(replPort),
        '--bind_ip',
        '127.0.0.1',
        '--dbpath',
        replDbDir,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );
    replProc.stderr?.on('data', (chunk: Buffer) => {
      spawnStderr += chunk.toString();
      if (spawnStderr.length > 2000) spawnStderr = spawnStderr.slice(-2000);
    });

    const directUri = `mongodb://127.0.0.1:${replPort}/tripledger_test_sole_org_replset?directConnection=true`;
    let connected = false;
    for (let i = 0; i < 40; i++) {
      if (replProc.exitCode !== null) {
        throw new Error(
          `mongod exited early (${replProc.exitCode}). Stderr: ${spawnStderr}`
        );
      }
      try {
        await mongoose.connect(directUri, { serverSelectionTimeoutMS: 500 });
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!connected) {
      throw new Error(`Timed out connecting to spawned replica-set mongod on port ${replPort}.`);
    }

    await mongoose.connection.db!.admin().command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `127.0.0.1:${replPort}` }],
      },
    });

    let isPrimary = false;
    for (let i = 0; i < 40; i++) {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      if (hello.isWritablePrimary || hello.ismaster) {
        isPrimary = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!isPrimary) {
      throw new Error('Replica set rs0 failed to elect a writable primary within timeout.');
    }
    if (!(await supportsTransactions())) {
      throw new Error('Spawned replica set does not support transactions.');
    }

    return { cleanup: cleanupLocal };
  } catch (err) {
    await cleanupLocal();
    throw err;
  }
}

async function verifyLatestOutboxUserEmail(app: ReturnType<typeof createApp>) {
  const outbox = getTestEmailOutbox();
  const latest = outbox[outbox.length - 1];
  if (!latest?.verificationUrl) {
    throw new Error('Missing verification email in test outbox');
  }
  const verifyTok = new URL(latest.verificationUrl).searchParams.get('token')!;
  const verifyRes = await request(app).post('/api/v1/auth/verify-email').send({ token: verifyTok });
  expect(verifyRes.status).toBe(200);
}

async function promoteParticipantToOrganizerViaInvite(params: {
  app: ReturnType<typeof createApp>;
  tripId: string;
  organizerToken: string;
  participantId: string;
  targetEmail: string;
  targetToken: string;
}) {
  const inviteRes = await request(params.app)
    .post(`/api/v1/trips/${params.tripId}/participants/${params.participantId}/invites`)
    .set('Authorization', `Bearer ${params.organizerToken}`)
    .send({
      grantedRole: 'ORGANIZER',
      intendedEmail: params.targetEmail,
    });
  expect(inviteRes.status).toBe(201);

  const claimRes = await request(params.app)
    .post('/api/v1/trips/invites/claim')
    .set('Authorization', `Bearer ${params.targetToken}`)
    .send({ token: inviteRes.body.data.rawToken as string });
  expect(claimRes.status).toBe(200);
  expect(claimRes.body.data.role).toBe('ORGANIZER');
}

async function seedTripWithOrganizers(
  app: ReturnType<typeof createApp>,
  coOrganizerCount = 1,
  includeUnlinkedGuestOrganizer = false
) {
  const creatorEmail = `creator.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
  const creatorReg = await request(app).post('/api/v1/auth/register').send({
    name: 'Lead Organizer',
    email: creatorEmail,
    password: 'Password123',
  });
  expect(creatorReg.status).toBe(201);
  const creatorToken = creatorReg.body.data.accessToken as string;
  await verifyLatestOutboxUserEmail(app);

  const tripRes = await request(app)
    .post('/api/v1/trips')
    .set('Authorization', `Bearer ${creatorToken}`)
    .send({ name: 'Annapurna Governance Trip', mode: 'FRIENDS' });
  expect(tripRes.status).toBe(201);

  const tripId = tripRes.body.data.trip.id as string;
  const inviteCode = tripRes.body.data.trip.inviteCode as string;
  const creatorParticipantId = tripRes.body.data.myParticipant.id as string;

  const coOrganizers: Array<{
    userId: string;
    email: string;
    participantId: string;
    accessToken: string;
  }> = [];
  for (let i = 0; i < coOrganizerCount; i++) {
    const coEmail = `coorg.${i}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
    const coReg = await request(app).post('/api/v1/auth/register').send({
      name: `CoOrg ${i + 1}`,
      email: coEmail,
      password: 'Password123',
    });
    expect(coReg.status).toBe(201);
    const coToken = coReg.body.data.accessToken as string;
    const coUserId = coReg.body.data.user.id as string;

    await verifyLatestOutboxUserEmail(app);

    const joinRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${coToken}`);
    expect(joinRes.status).toBe(200);
    const coParticipantId = joinRes.body.data.participantId as string;

    await promoteParticipantToOrganizerViaInvite({
      app,
      tripId,
      organizerToken: creatorToken,
      participantId: coParticipantId,
      targetEmail: coEmail,
      targetToken: coToken,
    });

    coOrganizers.push({
      userId: coUserId,
      email: coEmail,
      participantId: coParticipantId,
      accessToken: coToken,
    });
  }

  let guestOrganizerId: string | null = null;
  if (includeUnlinkedGuestOrganizer) {
    // Phase 3 blocks HTTP creation of privileged guests; insert a historical unlinked ORGANIZER row
    // directly in MongoDB to verify such legacy rows still cannot satisfy the linked-organizer invariant.
    const blockedHttpGuest = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        name: 'Blocked HTTP Guest Org',
        role: 'ORGANIZER',
        memberType: 'ADULT',
        defaultWeight: 1,
      });
    expect(blockedHttpGuest.status).toBe(400);

    const legacyGuest = await ParticipantModel.create({
      tripId,
      userId: null,
      name: 'Guest Unlinked Organizer',
      role: 'ORGANIZER',
      memberType: 'ADULT',
      defaultWeight: 1,
      isActive: true,
    });
    expect(legacyGuest.userId).toBeNull();
    expect(legacyGuest.role).toBe('ORGANIZER');
    guestOrganizerId = legacyGuest._id.toString();
  }

  return {
    tripId,
    inviteCode,
    creatorToken,
    creatorParticipantId,
    coOrganizers,
    guestOrganizerId,
  };
}

describe('Sole Active Linked Organizer Invariant (F-02 Pre-Phase-3 Hardening)', () => {
  const appInstanceA = createApp();
  const appInstanceB = createApp();

  describe('Standalone MongoDB distributed lease + compensating rollback', () => {
    beforeAll(async () => {
      await connectDatabase(STANDALONE_TEST_DB_URI);
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
      ]);
    }, 30000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
      ]);
    });

    afterEach(() => {
      clearTestEmailOutbox();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await disconnectDatabase();
    });

    it('1. prevents an unlinked guest ORGANIZER from satisfying the sole-linked-organizer invariant on demote, deactivate, and remove', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 0, true);
      expect(fx.guestOrganizerId).toBeTruthy();

      // Demoting the sole active LINKED organizer must fail even though an active unlinked guest ORGANIZER exists
      const demoteLead = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteLead.status).toBe(400);
      expect(demoteLead.body.error.code).toBe('SOLE_ORGANIZER');

      // Deactivating the sole active LINKED organizer must also fail
      const deactivateLead = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ isActive: false });
      expect(deactivateLead.status).toBe(400);
      expect(deactivateLead.body.error.code).toBe('SOLE_ORGANIZER');

      // Removing the sole active LINKED organizer must also fail
      const removeLead = await request(appInstanceA)
        .delete(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`);
      expect(removeLead.status).toBe(400);
      expect(removeLead.body.error.code).toBe('SOLE_ORGANIZER');

      // Conversely, demoting then reactivating/removing the unlinked guest ORGANIZER works because 1 linked organizer remains
      const demoteGuest = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.guestOrganizerId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteGuest.status).toBe(200);
      expect(demoteGuest.body.data.participant.role).toBe('PARTICIPANT');

      const removeGuest = await request(appInstanceA)
        .delete(`/api/v1/trips/${fx.tripId}/participants/${fx.guestOrganizerId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`);
      expect(removeGuest.status).toBe(200);

      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(1);
    });

    it('2. allows valid co-organizer demotion, deactivation, and removal while blocking reducing active linked organizers below 1', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 1, false);
      const co = fx.coOrganizers[0]!;
      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);

      // Lead demotes CoOrg -> succeeds cleanly, 1 linked organizer remains
      const demoteCo = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'CONTRIBUTOR' });
      expect(demoteCo.status).toBe(200);
      expect(demoteCo.body.data.participant.role).toBe('CONTRIBUTOR');
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(1);

      // Remaining sole linked organizer cannot demote or remove themselves
      const demoteLast = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteLast.status).toBe(400);
      expect(demoteLast.body.error.code).toBe('SOLE_ORGANIZER');

      // Re-promote CoOrg via verified ParticipantInvite -> 2 linked organizers, then Lead deactivates CoOrg cleanly, leaving Lead -> Lead cannot remove themselves
      await promoteParticipantToOrganizerViaInvite({
        app: appInstanceA,
        tripId: fx.tripId,
        organizerToken: fx.creatorToken,
        participantId: co.participantId,
        targetEmail: co.email,
        targetToken: co.accessToken,
      });
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);

      // Inactive linked ORGANIZER must NOT satisfy minimum-1 active linked organizer invariant
      const deactivateCo = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ isActive: false });
      expect(deactivateCo.status).toBe(200);
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(1);

      const removeLastDespiteInactiveCo = await request(appInstanceA)
        .delete(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`);
      expect(removeLastDespiteInactiveCo.status).toBe(400);
      expect(removeLastDespiteInactiveCo.body.error.code).toBe('SOLE_ORGANIZER');
    });

    it('3. serializes concurrent co-organizer demotions across two independent server instances without zero-organizer state', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 1, true);
      const co = fx.coOrganizers[0]!;
      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);

      // Concurrent self-demotions fired simultaneously against two distinct app instances sharing only MongoDB
      const [resA, resB] = await Promise.all([
        request(appInstanceA)
          .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
          .set('Authorization', `Bearer ${fx.creatorToken}`)
          .send({ role: 'PARTICIPANT' }),
        request(appInstanceB)
          .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
          .set('Authorization', `Bearer ${co.accessToken}`)
          .send({ role: 'PARTICIPANT' }),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 400]);
      const loser = resA.status === 400 ? resA : resB;
      expect(loser.body.error.code).toBe('SOLE_ORGANIZER');

      // Invariant holds even with the guest ORGANIZER present
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(1);
    });

    it('4. serializes concurrent co-organizer deactivation and deletion bursts (4 co-organizers) leaving at least 1 active linked organizer', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 3, true);
      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(4);

      const allOrganizers = [
        { participantId: fx.creatorParticipantId, accessToken: fx.creatorToken },
        ...fx.coOrganizers.map((c) => ({
          participantId: c.participantId,
          accessToken: c.accessToken,
        })),
      ];

      // Fire 4 simultaneous self-deletions / deactivations alternating across appInstanceA & appInstanceB
      const responses = await Promise.all(
        allOrganizers.map((org, idx) => {
          const targetApp = idx % 2 === 0 ? appInstanceA : appInstanceB;
          if (idx < 2) {
            return request(targetApp)
              .delete(`/api/v1/trips/${fx.tripId}/participants/${org.participantId}`)
              .set('Authorization', `Bearer ${org.accessToken}`);
          }
          return request(targetApp)
            .patch(`/api/v1/trips/${fx.tripId}/participants/${org.participantId}`)
            .set('Authorization', `Bearer ${org.accessToken}`)
            .send({ isActive: false });
        })
      );

      const successes = responses.filter((r) => r.status === 200);
      const rejections = responses.filter((r) => r.status === 400);
      expect(successes).toHaveLength(3);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]!.body.error.code).toBe('SOLE_ORGANIZER');

      const remaining = await ParticipantModel.find(activeLinkedOrganizerFilter(tripObjId)).lean();
      expect(remaining).toHaveLength(1);
    });

    it('5. fails closed on lease timeout in standalone mode and recovers expired leases from crashed instances', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 1, false);
      const co = fx.coOrganizers[0]!;

      // Simulate another server instance actively holding an unexpired lease on Trip
      await TripModel.updateOne(
        { _id: fx.tripId },
        {
          $set: {
            organizerMutationLock: {
              owner: 'remote-instance-active-lock',
              expiresAt: new Date(Date.now() + 15000),
            },
          },
        }
      );

      const blockedRes = await request(appInstanceB)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });

      expect(blockedRes.status).toBe(409);
      expect(blockedRes.body.error.code).toBe('CONCURRENT_MODIFICATION');
      // Must NOT silently apply update without holding the lock
      expect((await ParticipantModel.findById(co.participantId))?.role).toBe('ORGANIZER');

      // Now simulate an expired lease left by a crashed process (expiresAt in the past)
      await TripModel.updateOne(
        { _id: fx.tripId },
        {
          $set: {
            organizerMutationLock: {
              owner: 'crashed-instance-stale-lock',
              expiresAt: new Date(Date.now() - 1000),
            },
          },
        }
      );

      const recoveredRes = await request(appInstanceB)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(recoveredRes.status).toBe(200);
      expect(recoveredRes.body.data.participant.role).toBe('PARTICIPANT');

      const tripAfter = await TripModel.findById(fx.tripId).lean();
      expect(tripAfter?.organizerMutationLock?.owner).toBeNull();
    });

    it('6. restores original organizer state via compensating rollback and releases lease when persistence fails mid-operation', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 1, false);
      const co = fx.coOrganizers[0]!;
      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);

      // 6a. Simulate post-save persistence failure on updateParticipant demotion
      const originalCountDocs = ParticipantModel.countDocuments.bind(ParticipantModel);
      let countCall = 0;
      vi.spyOn(ParticipantModel, 'countDocuments').mockImplementation(((...args: unknown[]) => {
        countCall += 1;
        if (countCall === 2) {
          throw new Error('Simulated DB connection drop right after participant.save');
        }
        return originalCountDocs(...(args as Parameters<typeof ParticipantModel.countDocuments>));
      }) as typeof ParticipantModel.countDocuments);

      const failedDemote = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT', name: 'Tampered Name' });
      expect(failedDemote.status).toBe(500);
      vi.restoreAllMocks();

      const coAfterFailedDemote = await ParticipantModel.findById(co.participantId).lean();
      expect(coAfterFailedDemote?.role).toBe('ORGANIZER');
      expect(coAfterFailedDemote?.name).toBe('CoOrg 1');
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);
      expect((await TripModel.findById(fx.tripId).lean())?.organizerMutationLock?.owner).toBeNull();

      // 6b. Simulate post-delete persistence failure on removeParticipant
      let removeCountCall = 0;
      vi.spyOn(ParticipantModel, 'countDocuments').mockImplementation(((...args: unknown[]) => {
        removeCountCall += 1;
        if (removeCountCall === 2) {
          throw new Error('Simulated DB fault right after deleteOne');
        }
        return originalCountDocs(...(args as Parameters<typeof ParticipantModel.countDocuments>));
      }) as typeof ParticipantModel.countDocuments);

      const failedRemove = await request(appInstanceA)
        .delete(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`);
      expect(failedRemove.status).toBe(500);
      vi.restoreAllMocks();

      // Compensating upsert rollback must restore the deleted CoOrg document completely
      const coAfterFailedRemove = await ParticipantModel.findById(co.participantId).lean();
      expect(coAfterFailedRemove).toBeTruthy();
      expect(coAfterFailedRemove?.role).toBe('ORGANIZER');
      expect(coAfterFailedRemove?.userId?.toString()).toBe(co.userId);
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);
    });

    it('7. fails closed with 503 TRANSACTIONS_UNAVAILABLE when NODE_ENV=production runs against standalone MongoDB', async () => {
      const fx = await seedTripWithOrganizers(appInstanceA, 1, false);
      const co = fx.coOrganizers[0]!;
      const prevNodeEnv = process.env.NODE_ENV;
      const prevMongoTx = process.env.MONGO_TRANSACTIONS;

      try {
        process.env.NODE_ENV = 'production';
        process.env.MONGO_TRANSACTIONS = 'disabled';

        const prodRes = await request(appInstanceA)
          .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
          .set('Authorization', `Bearer ${fx.creatorToken}`)
          .send({ role: 'PARTICIPANT' });

        expect(prodRes.status).toBe(503);
        expect(prodRes.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
        expect((await ParticipantModel.findById(co.participantId))?.role).toBe('ORGANIZER');
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
        if (prevMongoTx === undefined) delete process.env.MONGO_TRANSACTIONS;
        else process.env.MONGO_TRANSACTIONS = prevMongoTx;
      }
    });
  });

  describe('Real MongoDB Replica Set multi-document ACID transaction serialization', () => {
    let cleanupReplSet: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      const started = await startOrConnectReplicaSet();
      cleanupReplSet = started.cleanup;
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
      ]);
    }, 60000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
      ]);
    });

    afterEach(() => {
      clearTestEmailOutbox();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (cleanupReplSet) {
        await cleanupReplSet();
      }
    }, 30000);

    it('8. prevents WiredTiger snapshot-isolation write skew via shared Trip transaction write lock and aborts cleanly on failure', async () => {
      expect(await supportsTransactions()).toBe(true);
      const fx = await seedTripWithOrganizers(appInstanceA, 1, true);
      const co = fx.coOrganizers[0]!;
      const tripObjId = new mongoose.Types.ObjectId(fx.tripId);

      // Verify ClientSession propagates to TripModel.findOneAndUpdate & organizerLockVersion increments
      const tripUpdateSpy = vi.spyOn(TripModel, 'findOneAndUpdate');
      const demoteGuest = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.guestOrganizerId}`)
        .set('Authorization', `Bearer ${fx.creatorToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteGuest.status).toBe(200);
      expect(tripUpdateSpy).toHaveBeenCalled();
      const firstTripCallOpts = tripUpdateSpy.mock.calls[0]?.[2] as { session?: unknown } | undefined;
      expect(firstTripCallOpts?.session).toBeTruthy();
      vi.restoreAllMocks();

      const tripVersionBeforeRace =
        (await TripModel.findById(fx.tripId).lean())?.organizerLockVersion ?? 0;
      expect(tripVersionBeforeRace).toBeGreaterThanOrEqual(1);

      // Concurrent self-demotions touching two DIFFERENT Participant documents on real replica set:
      // without parent Trip write-lock, WiredTiger snapshot isolation would allow both to commit!
      const [resA, resB] = await Promise.all([
        request(appInstanceA)
          .patch(`/api/v1/trips/${fx.tripId}/participants/${fx.creatorParticipantId}`)
          .set('Authorization', `Bearer ${fx.creatorToken}`)
          .send({ role: 'PARTICIPANT' }),
        request(appInstanceB)
          .patch(`/api/v1/trips/${fx.tripId}/participants/${co.participantId}`)
          .set('Authorization', `Bearer ${co.accessToken}`)
          .send({ role: 'PARTICIPANT' }),
      ]);

      expect([resA.status, resB.status].sort((a, b) => a - b)).toEqual([200, 400]);
      const loser = resA.status === 400 ? resA : resB;
      expect(loser.body.error.code).toBe('SOLE_ORGANIZER');
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(1);

      // Test ACID abort inside replica-set transaction after participant.save({ session }):
      // Re-promote so there are 2 linked organizers, then fail right after participant.save({ session })
      const winnerParticipantId =
        resA.status === 400 ? fx.creatorParticipantId : co.participantId;
      const winnerToken = resA.status === 400 ? fx.creatorToken : co.accessToken;
      const loserParticipantId =
        resA.status === 200 ? fx.creatorParticipantId : co.participantId;
      const loserToken = resA.status === 200 ? fx.creatorToken : co.accessToken;
      const loserEmail =
        resA.status === 200
          ? (
              await request(appInstanceA)
                .get('/api/v1/auth/me')
                .set('Authorization', `Bearer ${fx.creatorToken}`)
            ).body.data.user.email
          : co.email;

      await promoteParticipantToOrganizerViaInvite({
        app: appInstanceA,
        tripId: fx.tripId,
        organizerToken: winnerToken,
        participantId: loserParticipantId,
        targetEmail: loserEmail,
        targetToken: loserToken,
      });
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);

      const lockVersionBeforeAbort =
        (await TripModel.findById(fx.tripId).lean())?.organizerLockVersion ?? 0;

      const originalCountDocs = ParticipantModel.countDocuments.bind(ParticipantModel);
      let callIdx = 0;
      vi.spyOn(ParticipantModel, 'countDocuments').mockImplementation(((...args: unknown[]) => {
        callIdx += 1;
        if (callIdx === 2) {
          throw new Error('Simulated failure inside active replica-set transaction');
        }
        return originalCountDocs(...(args as Parameters<typeof ParticipantModel.countDocuments>));
      }) as typeof ParticipantModel.countDocuments);

      const abortedDemote = await request(appInstanceA)
        .patch(`/api/v1/trips/${fx.tripId}/participants/${winnerParticipantId}`)
        .set('Authorization', `Bearer ${winnerToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(abortedDemote.status).toBe(500);
      vi.restoreAllMocks();

      // Transaction abort must roll back BOTH participant change AND Trip.organizerLockVersion increment
      expect((await ParticipantModel.findById(winnerParticipantId))?.role).toBe('ORGANIZER');
      expect((await TripModel.findById(fx.tripId).lean())?.organizerLockVersion).toBe(
        lockVersionBeforeAbort
      );
      expect(await countActiveLinkedOrganizers(tripObjId)).toBe(2);
    });
  });
});
