/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import fastq, { queueAsPromised } from "fastq";
import split2 from "split2";
import { Level } from "level";
import enhancedFetch from "make-fetch-happen";
import { access } from "node:fs/promises";
import { Logger } from "pino";

const DEFAULT_DELAY_BETWEEN_FULL_UPDATES_MS = 1000 * 60 * 30;

export type PassportScore = {
  address: string;
  score: string | null;
  status: string;
  last_score_timestamp: string;
  evidence: {
    type: string;
    success: boolean;
    rawScore: string;
    threshold: string;
  } | null;
  error?: string | null;
  detail?: string;
};

export type AddressToPassportScoreMap = Map<string, PassportScore | undefined>;

export interface PassportProviderConfig {
  scorerId: number;
  logger: Logger;
  dbPath: string;
  fetch?: typeof enhancedFetch;
  delayBetweenFullUpdatesMs?: number;
}

type PassportProviderState =
  | { type: "empty" }
  | {
      type: "starting";
      pollTimeoutId: null;
      db: Level<string, PassportScore>;
    }
  | {
      type: "ready";
      pollTimeoutId: NodeJS.Timeout | null;
      db: Level<string, PassportScore>;
    }
  | {
      type: "stopped";
      pollTimeoutId: null;
    };

export interface PassportProvider {
  start: (opts?: { watch: boolean }) => Promise<void>;
  stop: () => void;
  getScoreByAddress: (address: string) => Promise<PassportScore | undefined>;
  getScoresByAddresses: (
    addresses: string[]
  ) => Promise<AddressToPassportScoreMap>;
}

export const createPassportProvider = (
  config: PassportProviderConfig
): PassportProvider => {
  // CONFIG

  const { logger } = config;
  const fetch = config.fetch ?? enhancedFetch;
  const delayBetweenFullUpdatesMs =
    config.delayBetweenFullUpdatesMs ?? DEFAULT_DELAY_BETWEEN_FULL_UPDATES_MS;

  // STATE

  let state: PassportProviderState = {
    type: "empty",
  };

  // API

  const start: PassportProvider["start"] = async (opts = { watch: true }) => {
    if (state.type !== "empty") {
      throw new Error(`Service not in empty state (${state.type})`);
    }

    logger.info({
      msg: `${state.type} => starting`,
      config: {
        scorerId: config.scorerId,
        dbPath: config.dbPath,
        delayBetweenFullUpdatesMs: config.delayBetweenFullUpdatesMs,
      },
    });

    try {
      await access(config.dbPath);

      logger.info("local passport dataset found");

      state = {
        type: "starting",
        pollTimeoutId: null,
        db: new Level<string, PassportScore>(config.dbPath, {
          valueEncoding: "json",
        }),
      };
    } catch (err) {
      logger.info(
        "no passports dataset found locally, fetching remote dataset before starting"
      );

      state = {
        type: "starting",
        pollTimeoutId: null,
        db: new Level<string, PassportScore>(config.dbPath, {
          valueEncoding: "json",
        }),
      };

      await runFullUpdate();
    }

    logger.info(`${state.type} => ready`);
    state = { ...state, type: "ready" };
    if (opts.watch) {
      state.pollTimeoutId = setTimeout(poll, delayBetweenFullUpdatesMs);
    }
  };

  const stop: PassportProvider["stop"] = () => {
    if (state.type !== "ready") {
      throw new Error("Service not started");
    }

    if (state.pollTimeoutId !== null) {
      clearTimeout(state.pollTimeoutId);
    }

    logger.info(`${state.type} => stopped`);
    state = { type: "stopped", pollTimeoutId: null };
  };

  const getScoreByAddress: PassportProvider["getScoreByAddress"] = async (
    address: string
  ): Promise<PassportScore | undefined> => {
    if (state.type !== "ready") {
      throw new Error("Service not started");
    }
    const { db } = state;

    try {
      return await db.get(address);
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "LEVEL_NOT_FOUND"
      ) {
        return undefined;
      } else {
        throw err;
      }
    }
  };

  const getScoresByAddresses: PassportProvider["getScoresByAddresses"] = async (
    addresses: string[]
  ): Promise<AddressToPassportScoreMap> => {
    if (state.type !== "ready") {
      throw new Error("Service not started");
    }
    const { db } = state;
    const uniqueAddresses = Array.from(new Set(addresses));
    const records = await db.getMany(uniqueAddresses);
    return new Map(
      records.filter(Boolean).map((record) => [record.address, record])
    );
  };

  // INTERNALS

  const poll = async (): Promise<void> => {
    if (state.type !== "ready") {
      throw new Error("Service not started");
    }

    await runFullUpdate();

    setTimeout(poll, DEFAULT_DELAY_BETWEEN_FULL_UPDATES_MS);
  };

  const runFullUpdate = async (): Promise<void> => {
    if (state.type !== "ready" && state.type !== "starting") {
      // Service might have been stopped while the data set was being fetched.
      return;
    }

    const queue: queueAsPromised<{ address: string; score: PassportScore }> =
      fastq.promise(async ({ address, score }) => {
        await db.put(address.toLowerCase(), score);
      }, 1);

    const startTime = Date.now();
    logger.debug("updating passports...");

    const { db } = state;
    const res = await fetch(
      "https://public.scorer.gitcoin.co/passport_scores/registry_score.jsonl"
    );
    const { body } = res;

    if (body === null) {
      throw new Error("Passport dump is empty");
    }

    await new Promise<void>((resolve, reject) => {
      body
        .pipe(split2())
        .on("data", (line: string) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const {
            passport: { address, community },
            ...rest
          } = JSON.parse(line);

          if (community === config.scorerId) {
            queue
              .push({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                address: address.toLowerCase(),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                score: { address, ...rest },
              })
              .catch((err) => {
                logger.error({
                  msg: "error while writing to passport dataset",
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  err,
                });
              });
          }
        })
        .on("end", () => {
          queue
            .drained()
            .then(() => {
              logger.debug(
                `processed passport dump in ${
                  (Date.now() - startTime) / 1000
                } seconds`
              );
              resolve();
            })
            .catch((err) => {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              logger.error({ err });
            });
        })
        .on("error", (err) => {
          logger.error({ msg: "error while reading from passport dump", err });
          reject(err);
        });
    });
  };

  // EXPORTS

  return {
    start,
    stop,
    getScoreByAddress,
    getScoresByAddresses,
  };
};
