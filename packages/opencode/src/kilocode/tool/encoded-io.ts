import { Effect } from "effect"
import { Encoding } from "../encoding"

/**
 * Effect wrappers around {@link Encoding.read} and {@link Encoding.write} so
 * tool code can preserve file encoding without leaking Node/async boilerplate
 * into each call site.
 */
export namespace EncodedIO {
  export const read = (path: string) => Effect.promise(() => Encoding.read(path))

  export const write = (path: string, text: string, encoding: string = Encoding.DEFAULT) =>
    Effect.promise(() => Encoding.write(path, text, encoding))
}
