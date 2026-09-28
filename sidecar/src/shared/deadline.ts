/** Race work against a deadline, always releasing the timer after settlement. */
export async function raceDeadline<T>(
  work: PromiseLike<T>,
  ms: number,
  onTimeout: () => T | PromiseLike<T>,
  { ref }: { ref: boolean }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout())
      } catch (error) {
        reject(error)
      }
    }, ms)
    if (!ref) timer.unref()
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
