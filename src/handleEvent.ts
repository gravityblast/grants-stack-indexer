import {
  Cache,
  Indexer as ChainsauceIndexer,
  JsonStorage,
  Event,
} from "chainsauce";
import { ethers } from "ethers";
import { fetchJson as ipfs } from "./ipfs.js";
import { getPrice } from "./coinGecko.js";

import RoundImplementationABI from "../abis/RoundImplementation.json" assert { type: "json" };
import QuadraticFundingImplementationABI from "../abis/QuadraticFundingVotingStrategyImplementation.json" assert { type: "json" };

type Indexer = ChainsauceIndexer<JsonStorage>;

async function convertToUSD(
  token: string,
  amount: ethers.BigNumber,
  chainId: number,
  fromTimestamp: number,
  toTimestamp: number,
  cache: Cache
): Promise<number> {
  const cacheKey = `price-${token}-${chainId}-${toTimestamp}-${fromTimestamp}`;

  const price = await cache.lazy<number>(cacheKey, () => {
    return getPrice(token, chainId, fromTimestamp, toTimestamp);
  });

  if (price === 0) {
    console.warn("Price not found for token:", token, "chainId:", chainId);
  }

  return Number(ethers.utils.formatUnits(amount, 18)) * price;
}

async function cachedIpfs<T>(cid: string, cache: Cache): Promise<T> {
  return await cache.lazy<T>(`ipfs-${cid}`, () => ipfs<T>(cid));
}

function fullProjectId(
  projectChainId: number,
  projectId: number,
  projectRegistryAddress: string
) {
  return ethers.utils.solidityKeccak256(
    ["uint256", "address", "uint256"],
    [projectChainId, projectRegistryAddress, projectId]
  );
}

async function handleEvent(indexer: Indexer, event: Event) {
  const db = indexer.storage;
  const chainId = indexer.chainId;

  switch (event.name) {
    // -- PROJECTS
    case "ProjectCreated": {
      await db.collection("projects").insert({
        fullId: fullProjectId(
          indexer.chainId,
          event.args.projectID.toNumber(),
          event.address
        ),
        id: event.args.projectID.toNumber(),
        metaPtr: null,
        votesUSD: 0,
        votes: 0,
        owners: [event.args.owner],
      });

      break;
    }

    case "MetadataUpdated": {
      const metadata = await cachedIpfs(
        event.args.metaPtr.pointer,
        indexer.cache
      );

      try {
        await db
          .collection("projects")
          .updateById(event.args.projectID.toNumber(), (project) => ({
            ...project,
            metaPtr: event.args.metaPtr.pointer,
            metadata: metadata,
          }));
      } catch (e) {
        console.error("Project not found", event.args.projectID.toNumber());
      }
      break;
    }

    case "OwnerAdded": {
      await db
        .collection("projects")
        .updateById(event.args.projectID.toNumber(), (project) => ({
          ...project,
          owners: [...project.owners, event.args.owner],
        }));
      break;
    }

    case "OwnerRemoved": {
      await db
        .collection("projects")
        .updateById(event.args.projectID.toNumber(), (project) => ({
          ...project,
          owners: project.owners.filter((o: string) => o == event.args.owner),
        }));
      break;
    }

    // --- ROUND
    case "RoundCreated": {
      const contract = indexer.subscribe(
        event.args.roundAddress,
        RoundImplementationABI,
        event.blockNumber
      );

      let applicationMetaPtr = contract.applicationMetaPtr();
      let applicationsStartTime = contract.applicationsStartTime();
      let applicationsEndTime = contract.applicationsEndTime();
      let roundStartTime = contract.roundStartTime();
      let roundEndTime = contract.roundEndTime();
      let applicationMetadata = await cachedIpfs(
        (
          await applicationMetaPtr
        ).pointer,
        indexer.cache
      );

      applicationMetaPtr = await applicationMetaPtr;
      applicationMetadata = await applicationMetadata;
      applicationsStartTime = (await applicationsStartTime).toString();
      applicationsEndTime = (await applicationsEndTime).toString();
      roundStartTime = (await roundStartTime).toString();
      roundEndTime = (await roundEndTime).toString();

      await db.collection("rounds").insert({
        id: event.args.roundAddress,
        votesUSD: 0,
        votes: 0,
        implementationAddress: event.args.roundImplementation,
        applicationMetaPtr,
        applicationMetadata,
        applicationsStartTime,
        applicationsEndTime,
        roundStartTime,
        roundEndTime,
      });
      break;
    }

    case "NewProjectApplication": {
      const project = await db
        .collection("projects")
        .findOneWhere((project) => project.fullId == event.args.project);

      await db.collection(`rounds/${event.address}/projects`).insert({
        id: event.args.project,
        projectId: project?.id ?? null,
        roundId: event.address,
        status: null,
      });
      break;
    }

    case "ProjectsMetaPtrUpdated": {
      const projects: { id: string; status: string; payoutAddress: string }[] =
        await cachedIpfs(event.args.newMetaPtr.pointer, indexer.cache);

      for (const projectApp of projects) {
        const projectId = projectApp.id.split("-")[0];

        await db
          .collection(`rounds/${event.address}/projects`)
          .updateById(projectId, (application) => ({
            ...application,
            status: projectApp.status,
            payoutAddress: projectApp.payoutAddress,
          }));
      }
      break;
    }

    // --- Voting Strategy
    case "VotingContractCreated": {
      indexer.subscribe(
        event.args.votingContractAddress,
        QuadraticFundingImplementationABI,
        event.blockNumber
      );
      break;
    }

    // --- Votes
    case "Voted": {
      const projectApplicationId = [
        event.args.projectId,
        event.args.roundAddress,
      ].join("-");

      const voteId = ethers.utils.solidityKeccak256(
        ["string"],
        [
          `${event.transactionHash}-${event.args.voter}-${event.args.grantAddress}`,
        ]
      );

      const projectApplication = await db
        .collection(`rounds/${event.args.roundAddress}/projects`)
        .findOneWhere((project) => project.id == event.args.projectId);

      const round = await db
        .collection(`rounds`)
        .findById(event.args.roundAddress);

      if (
        projectApplication === undefined ||
        projectApplication.status !== "APPROVED" ||
        round === undefined
      ) {
        console.warn(
          "Invalid vote:",
          event.args,
          "Application:",
          projectApplication,
          "Round:",
          round
        );
        return;
      }

      const now = new Date();

      const startDate = new Date(round.roundStartTime * 1000);
      // if round ends in the future, end it now to get live data
      const endDate = new Date(round.roundEndTime * 1000);

      const amountUSD = await convertToUSD(
        event.args.token.toLowerCase(),
        event.args.amount,
        chainId,
        Math.floor(startDate.getTime() / 1000),
        Math.floor(Math.min(now.getTime(), endDate.getTime()) / 1000),
        indexer.cache
      );

      const vote = {
        id: voteId,
        token: event.args.token,
        voter: event.args.voter,
        grantAddress: event.args.grantAddress,
        amount: event.args.amount.toString(),
        amountUSD: amountUSD,
        fullProjectId: event.args.projectId,
        roundAddress: event.args.roundAddress,
        projectApplicationId: projectApplicationId,
      };

      Promise.all([
        await db
          .collection(`rounds/${event.args.roundAddress}/votes`)
          .insert(vote),
        await db
          .collection(
            `rounds/${event.args.roundAddress}/projects/${event.args.projectId}/votes`
          )
          .insert(vote),
      ]);
      break;
    }

    default:
    // console.log("TODO", event.name, event.args);
  }
}

export default handleEvent;
