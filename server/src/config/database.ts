import mongoose from 'mongoose';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { env } from './env.js';

let localMongodProcess: ChildProcess | null = null;

export interface ConnectDatabaseOptions {
  autoIndex?: boolean;
}

/**
 * Connects to MongoDB. If the local MongoDB service is stopped on Windows,
 * automatically starts a local mongod.exe subprocess using `.data/mongodb` in the workspace
 * (or falls back to mongodb-memory-server if configured).
 */
export async function connectDatabase(
  uriOverride?: string,
  options?: ConnectDatabaseOptions
): Promise<void> {
  const targetUri = uriOverride ?? env.MONGODB_URI;
  const autoIndexOpt =
    options?.autoIndex !== undefined ? { autoIndex: options.autoIndex } : {};
  const isRemoteOrProd =
    env.NODE_ENV === 'production' ||
    targetUri.startsWith('mongodb+srv://') ||
    !/\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(targetUri);
  const serverSelectionTimeoutMS = isRemoteOrProd ? 15_000 : 2500;

  try {
    await mongoose.connect(targetUri, {
      serverSelectionTimeoutMS,
      ...autoIndexOpt,
    });
    return;
  } catch (initialError) {
    if (env.NODE_ENV === 'production') {
      throw initialError;
    }

    // Attempt to spawn local installed MongoDB 7.0 on Windows if service is stopped
    const winMongodPath = 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe';
    if (fs.existsSync(winMongodPath) && !localMongodProcess) {
      const dbPath = path.resolve(process.cwd(), '../.data/mongodb');
      fs.mkdirSync(dbPath, { recursive: true });

      localMongodProcess = spawn(
        winMongodPath,
        ['--dbpath', dbPath, '--port', '27017', '--bind_ip', '127.0.0.1'],
        {
          stdio: 'ignore',
          detached: false,
        }
      );

      // Wait briefly for local mongod to accept connections
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          await mongoose.connect(targetUri, {
            serverSelectionTimeoutMS: 1000,
            ...autoIndexOpt,
          });
          return;
        } catch {
          // continue waiting
        }
      }
    }

    throw initialError;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (localMongodProcess) {
    localMongodProcess.kill();
    localMongodProcess = null;
  }
}
