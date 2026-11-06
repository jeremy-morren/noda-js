// noda-js: the .NET library exceptions NodaTime (and noda-js's shims of the .NET library) throw. Each is a type: a
// NodaError whose Code is the .NET type's name (or the name of a type derived from it, as a C# catch clause catches
// derived types), plus the .NET type's own members (ArgumentException.ParamName, ...). The functions here create them.
// See docs/porting-conventions.md ("Exceptions").

import { NodaError } from "./NodaError.ts";
import type { NodaErrorCode, NodaErrorCodeOrDerived } from "./NodaError.ts";

/** System.ArgumentException (and the exceptions derived from it): an argument is invalid. */
export type ArgumentException = NodaError<NodaErrorCodeOrDerived<"ArgumentException">> & {
  /** The name of the invalid parameter, or null. */
  readonly ParamName: string | null;
};

/** System.ArgumentNullException: an argument is null (or undefined). */
export type ArgumentNullException = NodaError<NodaErrorCodeOrDerived<"ArgumentNullException">> & {
  /** The name of the parameter, or null. */
  readonly ParamName: string | null;
};

/** System.ArgumentOutOfRangeException (and the exceptions derived from it): an argument is out of range. */
export type ArgumentOutOfRangeException = NodaError<NodaErrorCodeOrDerived<"ArgumentOutOfRangeException">> & {
  /** The name of the parameter, or null. */
  readonly ParamName: string | null;
  /** The argument's value, if known. */
  readonly ActualValue: unknown;
};

/** System.ArithmeticException: the base of DivideByZeroException and OverflowException. */
export type ArithmeticException = NodaError<NodaErrorCodeOrDerived<"ArithmeticException">>;

/** System.DivideByZeroException: an integer division by zero. */
export type DivideByZeroException = NodaError<"DivideByZeroException">;

/** System.OverflowException: an arithmetic operation overflowed. */
export type OverflowException = NodaError<"OverflowException">;

/** System.FormatException (and the exceptions derived from it): text is in an invalid format. */
export type FormatException = NodaError<NodaErrorCodeOrDerived<"FormatException">>;

/** System.IndexOutOfRangeException: an index is outside the bounds of an array. */
export type IndexOutOfRangeException = NodaError<"IndexOutOfRangeException">;

/** System.InvalidCastException: a value isn't of the type it was cast to. */
export type InvalidCastException = NodaError<"InvalidCastException">;

/** System.InvalidOperationException: an operation isn't valid in the object's current state (or the host's). */
export type InvalidOperationException = NodaError<"InvalidOperationException">;

/** System.Collections.Generic.KeyNotFoundException: a key isn't in a dictionary. */
export type KeyNotFoundException = NodaError<"KeyNotFoundException">;

/** System.NotImplementedException: an operation isn't implemented. */
export type NotImplementedException = NodaError<"NotImplementedException">;

/** System.NotSupportedException: an operation isn't supported. */
export type NotSupportedException = NodaError<"NotSupportedException">;

/** System.IO.InvalidDataException: data (such as a tzdata archive) is invalid. */
export type InvalidDataException = NodaError<"InvalidDataException">;

/** System.Net.Http.HttpRequestException: a download failed (an HTTP error status). */
export type HttpRequestException = NodaError<"HttpRequestException"> & {
  /** The HTTP status code, if there was a response. */
  readonly StatusCode: number | null;
};

/** System.TimeZoneNotFoundException (and the exceptions derived from it): a time zone wasn't found. */
export type TimeZoneNotFoundException = NodaError<NodaErrorCodeOrDerived<"TimeZoneNotFoundException">>;

/** System.InvalidTimeZoneException: a system time zone's data is invalid (noda-js/system, on Windows). */
export type InvalidTimeZoneException = NodaError<"InvalidTimeZoneException">;

/** Creates a NodaError with extra members. */
function Create<T>(code: NodaErrorCode, message: string, members: object, options?: { cause?: unknown }): T {
  const error = new NodaError(code, message, options);
  Object.assign(error, members);
  return error as T;
}

/**
 * new ArgumentException(message, paramName).
 * @internal
 */
export function NewArgumentException(message?: string, paramName?: string | null, options?: { cause?: unknown }): ArgumentException {
  return Create("ArgumentException", message ?? "Value does not fall within the expected range.", { ParamName: paramName ?? null }, options);
}

/**
 * new ArgumentNullException(paramName, message).
 * @internal
 */
export function NewArgumentNullException(paramName?: string | null, message?: string): ArgumentNullException {
  return Create("ArgumentNullException", message ?? "Value cannot be null.", { ParamName: paramName ?? null });
}

/**
 * new ArgumentOutOfRangeException(paramName, actualValue, message).
 * @internal
 */
export function NewArgumentOutOfRangeException(paramName?: string | null, actualValue?: unknown, message?: string): ArgumentOutOfRangeException {
  return Create("ArgumentOutOfRangeException", message ?? "Specified argument was out of the range of valid values.",
    { ParamName: paramName ?? null, ActualValue: actualValue });
}

/**
 * new DivideByZeroException(message).
 * @internal
 */
export function NewDivideByZeroException(message?: string): DivideByZeroException {
  return new NodaError("DivideByZeroException", message ?? "Attempted to divide by zero.");
}

/**
 * new OverflowException(message).
 * @internal
 */
export function NewOverflowException(message?: string): OverflowException {
  return new NodaError("OverflowException", message ?? "Arithmetic operation resulted in an overflow.");
}

/**
 * new FormatException(message).
 * @internal
 */
export function NewFormatException(message?: string): FormatException {
  return new NodaError("FormatException", message ?? "One of the identified items was in an invalid format.");
}

/**
 * new IndexOutOfRangeException(message).
 * @internal
 */
export function NewIndexOutOfRangeException(message?: string): IndexOutOfRangeException {
  return new NodaError("IndexOutOfRangeException", message ?? "Index was outside the bounds of the array.");
}

/**
 * new InvalidCastException(message).
 * @internal
 */
export function NewInvalidCastException(message?: string): InvalidCastException {
  return new NodaError("InvalidCastException", message ?? "Specified cast is not valid.");
}

/**
 * new InvalidOperationException(message).
 * @internal
 */
export function NewInvalidOperationException(message?: string, options?: { cause?: unknown }): InvalidOperationException {
  return new NodaError("InvalidOperationException", message ?? "Operation is not valid due to the current state of the object.", options);
}

/**
 * new KeyNotFoundException(message).
 * @internal
 */
export function NewKeyNotFoundException(message?: string): KeyNotFoundException {
  return new NodaError("KeyNotFoundException", message ?? "The given key was not present in the dictionary.");
}

/**
 * new NotImplementedException(message).
 * @internal
 */
export function NewNotImplementedException(message?: string): NotImplementedException {
  return new NodaError("NotImplementedException", message ?? "The method or operation is not implemented.");
}

/**
 * new NotSupportedException(message).
 * @internal
 */
export function NewNotSupportedException(message?: string): NotSupportedException {
  return new NodaError("NotSupportedException", message ?? "Specified method is not supported.");
}

/**
 * new InvalidDataException(message).
 * @internal
 */
export function NewInvalidDataException(message?: string): InvalidDataException {
  return new NodaError("InvalidDataException", message ?? "Found invalid data while decoding.");
}

/**
 * new HttpRequestException(message, inner, statusCode).
 * @internal
 */
export function NewHttpRequestException(message: string, statusCode: number | null, options?: { cause?: unknown }): HttpRequestException {
  return Create("HttpRequestException", message, { StatusCode: statusCode }, options);
}

/**
 * new TimeZoneNotFoundException(message).
 * @internal
 */
export function NewTimeZoneNotFoundException(message?: string, options?: { cause?: unknown }): TimeZoneNotFoundException {
  return new NodaError("TimeZoneNotFoundException", message ?? "Exception of type 'System.TimeZoneNotFoundException' was thrown.", options);
}

/**
 * new InvalidTimeZoneException(message).
 * @internal
 */
export function NewInvalidTimeZoneException(message?: string, options?: { cause?: unknown }): InvalidTimeZoneException {
  return new NodaError("InvalidTimeZoneException", message ?? "Exception of type 'System.InvalidTimeZoneException' was thrown.", options);
}
