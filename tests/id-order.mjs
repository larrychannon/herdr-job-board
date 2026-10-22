// The tests written before 0.6.0 read their boards in id order (the oldest card on top), as the
// board showed them then. Since 0.6.0 new cards go on top; these put a board back in id order
// (`order` = id), so those tests keep testing what they were written for. tests/order.test.mjs
// tests the order itself.
import { existsSync, readFileSync, writeFileSync } from "node:fs"

/** The board file's cards in id order. */
export function idOrder(file) {
  if (!existsSync(file)) return
  const board = JSON.parse(readFileSync(file, "utf8"))
  for (const item of board.items || []) item.order = item.id
  writeFileSync(file, JSON.stringify(board))
}

/** A board's cards in id order, for a board written by the test itself. */
export const inIdOrder = (items) => items.map((i) => ({ ...i, order: i.id }))
