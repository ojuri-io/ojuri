type PaginatedData<T> = {
  data: Array<T>;
  page: number;
  dataSize: number;
  total: number;
  volume?: number;
};
