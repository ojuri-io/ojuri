export class Result<T> {
  public isSuccess: boolean;
  public isFailure: boolean;
  private value?: T;
  public error?: Error;

  private constructor(isSuccess: boolean, value?: T, error?: Error) {
    this.isSuccess = isSuccess;
    this.isFailure = !isSuccess;
    this.value = value;
    this.error = error;

    Object.freeze(this);
  }

  public getValue(): T {
    return this.value as T;
  }

  public static ok<U>(value?: U): Result<U> {
    return new Result<U>(true, value);
  }

  public static err<U>(error: Error): Result<U> {
    return new Result<U>(false, null as any, error);
  }
}
