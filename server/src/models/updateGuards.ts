import type mongoose from 'mongoose';

export function isMongooseQueryContext(ctx: unknown): boolean {
  return (
    typeof ctx === 'object' &&
    ctx !== null &&
    typeof (ctx as { getUpdate?: unknown }).getUpdate === 'function'
  );
}

export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidNonNaNDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Inspects a Mongoose update object (`$set`, `$unset`, `$rename`, `$setOnInsert`, shorthand
 * top-level keys, etc.) and returns every top-level field path referenced by the update.
 * Rejects aggregation pipeline updates (`Array.isArray`) because they bypass static path guards.
 */
export function collectTouchedUpdateFields(
  update: unknown,
  modelName: string
): {
  touchedFields: Set<string>;
  unsetFields: Set<string>;
  setValues: Map<string, unknown>;
  nonSetTouchedFields: Set<string>;
} {
  if (Array.isArray(update) || !isPlainObjectRecord(update)) {
    throw new Error(
      `Pipeline or non-object updates are prohibited on ${modelName} to preserve security invariants.`
    );
  }

  const touchedFields = new Set<string>();
  const unsetFields = new Set<string>();
  const setValues = new Map<string, unknown>();
  const nonSetTouchedFields = new Set<string>();

  const recordField = (rawKey: string) => {
    const baseField = rawKey.split('.')[0]?.trim();
    if (baseField) {
      touchedFields.add(baseField);
    }
    return baseField;
  };

  for (const [key, val] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      const base = recordField(key);
      if (base && key === base) {
        if (setValues.has(base)) {
          nonSetTouchedFields.add(base);
        } else {
          setValues.set(base, val);
        }
      } else if (base) {
        nonSetTouchedFields.add(base);
      }
      continue;
    }

    if (!isPlainObjectRecord(val)) {
      throw new Error(`Malformed update operator "${key}" on ${modelName}.`);
    }

    for (const [opKey, opVal] of Object.entries(val)) {
      const base = recordField(opKey);
      if (key === '$unset' && base) {
        unsetFields.add(base);
        nonSetTouchedFields.add(base);
      } else if (key === '$set' && base && opKey === base) {
        if (setValues.has(base)) {
          nonSetTouchedFields.add(base);
        } else {
          setValues.set(base, opVal);
        }
      } else {
        if (key === '$setOnInsert' && base && opKey === base && !setValues.has(base)) {
          setValues.set(base, opVal);
        }
        if (base) {
          nonSetTouchedFields.add(base);
        }
        if (key === '$rename' && typeof opVal === 'string') {
          const targetBase = recordField(opVal);
          if (targetBase) {
            nonSetTouchedFields.add(targetBase);
          }
        }
      }
    }
  }

  return { touchedFields, unsetFields, setValues, nonSetTouchedFields };
}

export function assertAllowedQueryOptions(
  query: mongoose.Query<unknown, unknown>,
  modelName: string
): void {
  const options = query.getOptions() as Record<string, unknown>;
  const mongooseOptions = (
    query as unknown as { _mongooseOptions?: Record<string, unknown> }
  )._mongooseOptions;

  if (options.overwriteImmutable === true || mongooseOptions?.overwriteImmutable === true) {
    throw new Error(`overwriteImmutable is prohibited on ${modelName}.`);
  }
  if (options.strict === false || mongooseOptions?.strict === false) {
    throw new Error(`strict: false updates are prohibited on ${modelName}.`);
  }
}

export function assertQueryUpdatePreservesImmutableFields(
  query: mongoose.Query<unknown, unknown>,
  immutableFields: ReadonlySet<string>,
  modelName: string
): ReturnType<typeof collectTouchedUpdateFields> {
  assertAllowedQueryOptions(query, modelName);

  const parsed = collectTouchedUpdateFields(query.getUpdate(), modelName);
  const blocked = Array.from(parsed.touchedFields).filter((f) => immutableFields.has(f));
  if (blocked.length > 0) {
    throw new Error(
      `Cannot modify immutable ${modelName} security field(s): ${blocked.sort().join(', ')}.`
    );
  }

  return parsed;
}
