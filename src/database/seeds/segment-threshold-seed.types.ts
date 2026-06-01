import { TransactionType } from "@shared/enums/transaction-type.enum";

export interface SegmentThresholdSeedEntry {
  segment: TransactionType;
  threshold: number;
}
