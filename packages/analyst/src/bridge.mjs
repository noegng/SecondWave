/**
 * Pont core → analyste : objet ledger + `.metrics` → snapshots camelCase.
 */
export function toAnalystInput(graph, { didVerified = true } = {}) {
  const vm = graph.metrics ?? {}
  const vault = {
    vaultId: graph.vaultId,
    assetsTotal: vm.assetsTotal ?? graph.vault?.AssetsTotal,
    assetsAvailable: vm.assetsAvailable ?? graph.vault?.AssetsAvailable,
    lossUnrealized: vm.lossUnrealized ?? graph.vault?.LossUnrealized,
    sharesOutstanding: vm.outstandingShares ?? graph.vault?.shares?.OutstandingAmount,
    vaultKind: Number(graph.vault?.VaultKind ?? 0),
    subscriptionDate: Number(graph.vault?.SubscriptionDate ?? 0),
    redemptionDate: Number(graph.vault?.RedemptionDate ?? 0),
  }
  const brokers = (graph.brokers ?? []).map((b) => ({
    broker: {
      loanBrokerId: b.index,
      vaultId: graph.vaultId,
      debtTotal: b.metrics?.debtTotal ?? b.DebtTotal ?? '0',
      coverAvailable: b.metrics?.coverAvailable ?? b.CoverAvailable ?? '0',
      coverRateMinimum: b.metrics?.coverRateMinimum ?? Number(b.CoverRateMinimum ?? 0),
      coverRateLiquidation: b.metrics?.coverRateLiquidation ?? Number(b.CoverRateLiquidation ?? 0),
      managementFeeRate: Number(b.ManagementFeeRate ?? 0),
      didVerified,
    },
    loans: (b.loans ?? []).map((l) => ({
      loanId: l.index,
      principalOutstanding: l.metrics?.principalOutstanding ?? l.PrincipalOutstanding ?? '0',
      totalValueOutstanding: l.metrics?.totalValueOutstanding ?? l.TotalValueOutstanding ?? '0',
      managementFeeOutstanding: l.ManagementFeeOutstanding ?? '0',
      nextPaymentDueDate: Number(l.NextPaymentDueDate ?? 0),
      gracePeriod: Number(l.GracePeriod ?? 0),
      flags: Number(l.Flags ?? 0),
    })),
  }))
  return { vault, brokers }
}
