import { SavedReportFilters } from "@shared/reports/saved-reports.service";

export interface CreateSavedReportDto {
  name: string;
  description?: string;
  dataSource: "audit";
  filters?: SavedReportFilters;
  columns?: string[];
}

export interface UpdateSavedReportDto {
  name?: string;
  description?: string | null;
  dataSource?: "audit";
  filters?: SavedReportFilters;
  columns?: string[];
}

export interface RunSavedReportDto {
  override?: SavedReportFilters;
}
