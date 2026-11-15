/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "battleships-6x6-idsyrl", name: "初识舰队", width: 6, height: 6, difficulty: 'easy', series: "入门", board: "001220020200200102002000100020000020|3,2,2,1,1|3,0,3,0,1,2|1,1,3,2,1,1", solution: "211221222222221112222222122222221122" },
  { id: "battleships-7x7-idsyrm", name: "七海巡航", width: 7, height: 7, difficulty: 'easy', series: "入门", board: "0001000020000001000000200010000000200000000002000|3,3,2,1,1|1,1,4,1,1,1,1|0,3,1,2,0,4,0", solution: "2221222222221221112122222212212222221222222222212" },
  { id: "battleships-8x8-idsyrn", name: "舰队回廊", width: 8, height: 8, difficulty: 'medium', series: "进阶", board: "2001002200002200002000000000100220201000200002000000000000000002|4,3,2,2,1,1|2,0,2,2,2,1,1,3|3,0,0,1,5,0,4,0", solution: "2221122222222222122212221222122222221212222222122222221212221212" },
  { id: "battleships-8x8-idsyro", name: "深海编队", width: 8, height: 8, difficulty: 'medium', series: "进阶", board: "0000000000000000000000000000000000000000000000000000000000000000|4,3,3,2,1,1|0,2,1,2,2,1,4,2|2,0,2,1,5,1,0,3", solution: "2222222212221222222212222212122222121222222222212221112112222221" },
  { id: "battleships-8x8-idsyrp", name: "钢铁洪流", width: 8, height: 8, difficulty: 'hard', series: "挑战", board: "1020022222101222022202202200101202020002001022200202222101201120|4,3,3,2,2,1,1|1,3,0,4,0,3,1,4|2,2,2,2,3,2,1,2", solution: "1222222222111222222222222221111222222222111222222222222121221121" },
  { id: "battleships-8x8-idsyrq", name: "舰队终局", width: 8, height: 8, difficulty: 'hard', series: "挑战", board: "0000000000000000000022000000000000000000000010002002200002101100|5,3,3,2,2,1,1|1,2,2,2,3,2,0,5|2,0,4,1,2,3,1,4", solution: "2222222122222121221222211212222212122221222211222222222222111112" },
]
