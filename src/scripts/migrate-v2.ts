import {
  getAllLegacySeenContractRows,
  getAllLegacyTokenMetadataRows,
  upsertContractsRegistryBatch,
  upsertSelectorsTempBatch,
  upsertTokenRegistryBatch,
} from '../db.js';

function migrateTokens(): { total: number; perChain: Record<string, number> } {
  const rows = getAllLegacyTokenMetadataRows();
  const byChain = new Map<string, typeof rows>();

  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  const perChain: Record<string, number> = {};
  for (const [chain, chainRows] of byChain) {
    upsertTokenRegistryBatch(
      chain,
      chainRows.map((row) => ({
        address: row.token,
        name: row.name,
        symbol: row.symbol,
        tokenKind: row.tokenKind ?? null,
        priceUsd: row.tokenPriceUsd,
        created: row.tokenCreatedAt,
        callsSync: row.tokenCallsSync,
        isAutoAudited: row.isAutoAudited ?? false,
        isManualAudited: row.isManualAudited ?? false,
        isNative: row.isNative,
      })),
    );
    perChain[chain] = chainRows.length;
  }

  return { total: rows.length, perChain };
}

function migrateContracts(): {
  totalSeenRows: number;
  contractsUpserted: number;
  selectorsTempUpserted: number;
  perChain: Record<string, { contracts: number; selectorsTemp: number }>;
} {
  const rows = getAllLegacySeenContractRows();
  const byChain = new Map<string, typeof rows>();

  for (const row of rows) {
    const list = byChain.get(row.chain) ?? [];
    list.push(row);
    byChain.set(row.chain, list);
  }

  const perChain: Record<string, { contracts: number; selectorsTemp: number }> = {};
  let contractsUpserted = 0;
  let selectorsTempUpserted = 0;

  for (const [chain, chainRows] of byChain) {
    const byContract = new Map<string, (typeof chainRows)[number]>();
    for (const row of chainRows) {
      if (!byContract.has(row.contractAddress)) {
        byContract.set(row.contractAddress, row);
      }
    }

    const contractRows = [...byContract.values()].map((row) => {
      const linkType: 'proxy' | 'eip7702' | null = row.patternKind === 'implementation'
        ? 'proxy'
        : (row.patternKind === 'delegate' ? 'eip7702' : null);
      const linkage = linkType ? row.patternAddress : null;

      return {
        contractAddr: row.contractAddress,
        linkage,
        linkType,
        label: row.label,
        review: row.reviewText,
        selectorHash: row.patternHash,
        isExploitable: row.exploitable,
        portfolio: '{}',
        isAutoAudit: false,
        isManualAudit: false,
        whitelistPatterns: [],
        selectors: row.selectors,
        codeSize: row.bytecodeSize,
      };
    });

    const selectorMap = new Map<string, { contractAddr: string; selectorHash: string; selectors: string[]; label?: string }>();
    for (const row of chainRows) {
      if (!row.patternHash || !row.selectors.length) continue;
      const key = `${row.contractAddress}:${row.patternHash}`;
      if (selectorMap.has(key)) continue;
      selectorMap.set(key, {
        contractAddr: row.contractAddress,
        selectorHash: row.patternHash,
        selectors: row.selectors,
        label: row.label,
      });
    }
    const selectorRows = [...selectorMap.values()];

    upsertContractsRegistryBatch(chain, contractRows);
    upsertSelectorsTempBatch(chain, selectorRows);

    contractsUpserted += contractRows.length;
    selectorsTempUpserted += selectorRows.length;
    perChain[chain] = {
      contracts: contractRows.length,
      selectorsTemp: selectorRows.length,
    };
  }

  return {
    totalSeenRows: rows.length,
    contractsUpserted,
    selectorsTempUpserted,
    perChain,
  };
}

function printSummary(title: string, payload: unknown): void {
  console.log(`\n[${title}]`);
  console.log(JSON.stringify(payload, null, 2));
}

function main(): void {
  const tokenResult = migrateTokens();
  const contractResult = migrateContracts();

  printSummary('token-migration', tokenResult);
  printSummary('contract-migration', contractResult);
  console.log('\nMigration complete.');
}

main();
