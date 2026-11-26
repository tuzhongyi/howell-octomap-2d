import { OctomapProjection, PGM_DARK_MAX, PGM_FREE_MIN } from '../utils/pgm.util';
import {
  OctomapPgmGrid,
  OctomapPgmPath,
  OctomapPgmPlan,
  OctomapPgmPlanOptions,
} from './octomap-2d-pgm.model';

/**
 * 平滑时一根弦最多跨多少格。
 *
 * A* 在八邻网格上产出的是一条逐格折线，平地上会带出锯齿；拉直的判据是「两点之间
 * 连一条线，沿途都不碰障碍」。弦不设上限的话，一条横穿半张图的直线只要恰好从两片
 * 障碍之间挤过去就会被接受，看着像抄近路。取 256 格（默认 5 cm 下约 12.8 m）——
 * 比任何一张导航图的短边都长，实际上不限制正常场景，只挡住病态的图。
 */
const MAX_SMOOTH_CELLS = 256;

/** 线段判空时的采样密度：每格采几次。 */
const LINE_SAMPLES_PER_CELL = 4;

/** 最小二叉堆，A* 的开放集合。 */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) >= 0) {
        break;
      }
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
          smallest = left;
        }
        if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * 网格的像素上限。PGM 不像 canvas 那样受显示限制，可以很大（这张真图按 5 cm 存
 * 出来有一亿多像素）；不封顶的话三张 `Uint8Array` 加 A* 的记账表会直接把页面拖垮。
 */
const MAX_PGM_CELLS = 4_000_000;

/**
 * 把一张 PGM 图像变成二维导航网格。
 *
 * 像素按 {@link PGM_DARK_MAX} / {@link PGM_FREE_MIN} 分成黑、灰（未知）、白三档，
 * `mode` 决定哪一档可走；两档都不放行中间的灰色。行方向沿用 PGM：第 0 行是 Z 最大
 * 的一侧，与 `projectOccupancy` 的落格规则一致。分辨率（一格多少米）图里没有，由
 * `options.resolution` 给。
 *
 * 像素超过 {@link MAX_PGM_CELLS} 时按整数倍降采样：目标格只要包含一个障碍像素就
 * 整格算障碍（取块内最大值，宁可保守），同时把分辨率乘上同样的倍数，世界尺寸不变。
 *
 * 膨胀半径取 `dogRadius + 半格`，与三维寻路的 `CELL_SAFETY` 同一条理由：判定是格
 * 粒度的，障碍格心到自由格心的距离比「到真实障碍面」多出半格；补半格才能让
 * `blocked` 的边界大致落在真实障碍面上，而不是一律偏保守或偏激进。
 */
export function buildPgmGrid(
  image: OctomapProjection,
  options: OctomapPgmPlanOptions,
): OctomapPgmGrid {
  const scale = downsampleScale(image.width, image.height);
  const resolution = options.resolution * scale;

  // 先在原图上按口径标出障碍。两档都只认两端：`occupiedWalkable` 只放行黑，
  // `freeWalkable` 只放行白；介于两者之间的「未知」灰两边都算障碍。
  const sourceBlocked = new Uint8Array(image.data.length);
  for (let i = 0; i < sourceBlocked.length; i++) {
    const value = image.data[i];
    if (options.mode === 'occupiedWalkable') {
      sourceBlocked[i] = value <= PGM_DARK_MAX ? 0 : 1;
    } else {
      sourceBlocked[i] = value <= PGM_DARK_MAX || value < PGM_FREE_MIN ? 1 : 0;
    }
  }

  const width = Math.max(1, Math.ceil(image.width / scale));
  const height = Math.max(1, Math.ceil(image.height / scale));
  const rawBlocked =
    scale === 1
      ? sourceBlocked
      : reduceBlocked(sourceBlocked, image.width, image.height, width, height, scale);
  const blocked = inflateBlocked(rawBlocked, width, height, options.dogRadius, resolution);
  return {
    width,
    height,
    resolution,
    minX: 0,
    minZ: 0,
    groundLevel: 0,
    dogRadius: options.dogRadius,
    rawBlocked,
    blocked,
  };
}

/** 最小的整数倍，使降采样后的格数不超过 {@link MAX_PGM_CELLS}。 */
function downsampleScale(width: number, height: number): number {
  let scale = 1;
  while (Math.ceil(width / scale) * Math.ceil(height / scale) > MAX_PGM_CELLS) {
    scale++;
  }
  return scale;
}

/** 把 `scale × scale` 的像素块压成一格：块里只要有一个障碍，这一格就是障碍。 */
function reduceBlocked(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  scale: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const rowStart = row * scale;
    const rowEnd = Math.min(sourceHeight, rowStart + scale);
    for (let col = 0; col < width; col++) {
      const colStart = col * scale;
      const colEnd = Math.min(sourceWidth, colStart + scale);
      let blocked = 0;
      for (let r = rowStart; r < rowEnd && blocked === 0; r++) {
        const base = r * sourceWidth;
        for (let c = colStart; c < colEnd; c++) {
          if (source[base + c] !== 0) {
            blocked = 1;
            break;
          }
        }
      }
      out[row * width + col] = blocked;
    }
  }
  return out;
}

/**
 * 按小狗的碰撞半径把障碍往外扩。
 *
 * 直接遍历每个障碍格、在它的 `r` 邻域里盖圈，而不是逐格算到最近障碍的距离：前者
 * 的开销跟「障碍格数 × r²」走，后者跟「格数 × r²」走；真图上障碍远比空地少，
 * 而且默认 5 cm 网格、0.25 m 半径时 r 只有 5 格，差别不大。用平方距离比较，
 * 免掉开方。
 */
export function inflateBlocked(
  rawBlocked: Uint8Array,
  width: number,
  height: number,
  dogRadius: number,
  resolution: number,
): Uint8Array {
  const blocked = rawBlocked.slice();
  const radiusCells = Math.max(0, (dogRadius + resolution / 2) / resolution);
  const reach = Math.ceil(radiusCells);
  if (reach <= 0) {
    return blocked;
  }
  const maxDistanceSq = radiusCells * radiusCells;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (rawBlocked[row * width + col] === 0) {
        continue;
      }
      for (let dr = -reach; dr <= reach; dr++) {
        const r = row + dr;
        if (r < 0 || r >= height) {
          continue;
        }
        for (let dc = -reach; dc <= reach; dc++) {
          if (dr * dr + dc * dc > maxDistanceSq) {
            continue;
          }
          const c = col + dc;
          if (c >= 0 && c < width) {
            blocked[r * width + c] = 1;
          }
        }
      }
    }
  }
  return blocked;
}

/**
 * 在网格上规划一条从 `start` 到 `goal`（都是格索引）的路线。
 *
 * `start` / `goal` 是用户点中的原始格；落在不可通行格上时先吸附到最近的可通行格。
 * 终点用 `goalRadius`——与三维寻路的「终点范围」同一个意思：点歪了半米以内还能救，
 * 点进一整片墙里就直说够不着。
 *
 * 起点另外有 `startRadius`（吸附范围）与 `startClearance`（要求的最小净空）。净空
 * 比建图时的 `dogRadius` 更严时，会在原始障碍上再膨胀一张掩码、只在掩码上找落脚点：
 * 这样「起点要离墙更远」只影响起点，整张图的可走区域不变，路线也不会凭这个参数
 * 变宽。返回的 `startSnapped` 表示起点是否被挪过。
 *
 * 走不通时不只给一个 `'unreachable'`：A* 会顺手记下离终点最近的已探索格，这里把
 * 从起点到那一格的残段拉直后一并返回（`partialPath` / `stuckCell`），界面能把
 * 「走到哪里走不通」画出来。
 */
export function planPgmPath(
  grid: OctomapPgmGrid,
  start: number | null,
  goal: number | null,
  goalRadius: number,
  startRadius: number = goalRadius,
  startClearance: number | null = null,
): OctomapPgmPlan {
  if (start === null || goal === null) {
    return {
      path: null,
      reason: start === null ? 'noStart' : 'noGoal',
      startCell: null,
      goalCell: null,
      startSnapped: false,
      goalSnapped: false,
      stuckCell: null,
      partialPath: null,
    };
  }
  const goalSnapCells = Math.max(1, Math.ceil(goalRadius / grid.resolution));
  const startSnapCells = Math.max(1, Math.ceil(startRadius / grid.resolution));
  const startMask =
    startClearance !== null && startClearance > grid.dogRadius
      ? inflateBlocked(
          grid.rawBlocked,
          grid.width,
          grid.height,
          startClearance,
          grid.resolution,
        )
      : grid.blocked;

  const snappedStart = snapToFree(grid, start, startSnapCells, startMask);
  const snappedGoal = snapToFree(grid, goal, goalSnapCells);
  if (snappedStart < 0 || snappedGoal < 0) {
    return {
      path: null,
      reason: snappedStart < 0 ? 'blockedStart' : 'blockedGoal',
      startCell: snappedStart < 0 ? null : snappedStart,
      goalCell: snappedGoal < 0 ? null : snappedGoal,
      startSnapped: snappedStart !== start,
      goalSnapped: snappedGoal !== goal,
      stuckCell: null,
      partialPath: null,
    };
  }

  // 起点吸附到了更严的掩码上，但那一格对 A* 用的 blocked 来说必须仍然可走。
  // 掩码是 blocked 的超集（膨胀半径更大），这条恒成立；写成断言式的兜底，免得
  // 以后有人把两张掩码的来源改岔了，A* 从一格障碍里起步。
  if (grid.blocked[snappedStart] !== 0) {
    return {
      path: null,
      reason: 'blockedStart',
      startCell: null,
      goalCell: snappedGoal,
      startSnapped: snappedStart !== start,
      goalSnapped: snappedGoal !== goal,
      stuckCell: null,
      partialPath: null,
    };
  }

  const base = {
    startCell: snappedStart,
    goalCell: snappedGoal,
    startSnapped: snappedStart !== start,
    goalSnapped: snappedGoal !== goal,
  };
  const search = searchPgmPath(grid, snappedStart, snappedGoal);
  if (!search.cells) {
    return {
      ...base,
      path: null,
      reason: 'unreachable',
      stuckCell: search.best,
      partialPath: pathOf(grid, smoothPgmPath(grid, search.reachedCells)),
    };
  }
  return {
    ...base,
    path: pathOf(grid, smoothPgmPath(grid, search.cells)),
    reason: null,
    stuckCell: null,
    partialPath: null,
  };
}

/** 一格序列 → 世界坐标折线，顺带量总长。 */
function pathOf(grid: OctomapPgmGrid, cells: number[]): OctomapPgmPath {
  const world = cells.map((cell) => pgmCellToWorld(grid, cell));
  let length = 0;
  for (let i = 1; i < world.length; i++) {
    length += Math.hypot(
      world[i][0] - world[i - 1][0],
      world[i][1] - world[i - 1][1],
      world[i][2] - world[i - 1][2],
    );
  }
  return { cells, world, length };
}

/**
 * 找离 `cell` 最近的、膨胀后仍可通行的格。找不到（`maxCells` 之内全堵着）返回 -1。
 *
 * 逐圈扫描切比雪夫半径：同一圈里有多个空格时取欧氏距离最近的那一个，避免斜着
 * 点一下却吸附到正上方的格子上。范围本身由 `goalRadius` 决定，而不是「一直找到
 * 有空格为止」——后者会把点进墙里的终点悄悄吸附到墙另一侧，画出一条用户没要求的
 * 路线。
 */
export function snapToFree(
  grid: OctomapPgmGrid,
  cell: number,
  maxCells: number,
  blocked: Uint8Array = grid.blocked,
): number {
  if (cell < 0 || cell >= blocked.length) {
    return -1;
  }
  if (blocked[cell] === 0) {
    return cell;
  }
  const width = grid.width;
  const col = cell % width;
  const row = (cell / width) | 0;
  for (let radius = 1; radius <= maxCells; radius++) {
    let best = -1;
    let bestDistance = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      const r = row + dr;
      if (r < 0 || r >= grid.height) {
        continue;
      }
      const edgeRow = Math.abs(dr) === radius;
      const step = edgeRow ? 1 : radius * 2;
      for (let dc = -radius; dc <= radius; dc += step) {
        const c = col + dc;
        if (c < 0 || c >= width) {
          continue;
        }
        const candidate = r * width + c;
        if (blocked[candidate] !== 0) {
          continue;
        }
        const distance = dr * dr + dc * dc;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
    if (best >= 0) {
      return best;
    }
  }
  return -1;
}

/** A* 的完整结果：走到终点时 `cells` 有值，走不到时只有残段与卡住的格。 */
export interface PgmSearchResult {
  /** 起点到终点的格序列（含首尾）；走不到为 null。 */
  cells: number[] | null;
  /** 从起点能到达、离终点（按八方向距离）最近的已探索格。 */
  best: number;
  /** 从起点到 {@link best} 的格序列；走到终点时与 {@link cells} 相同。 */
  reachedCells: number[];
}

/**
 * 八邻 A*。
 *
 * 与普通 A* 的差别只有一件：走不到时不是直接返回失败，而是把整片连通区探完，挑
 * 一个启发值最小的已探索格当「最远走到这里」。启发值用的是八方向距离（octile），
 * 对终点而言它是真实距离的下界，所以最小启发值的那一格通常就贴在挡住去路的那堵
 * 墙后面，而不是随便某个边角。
 *
 * 对角移动要求两个正交邻居都可通行：否则路径会从两个对角相贴的障碍之间「挤」过去，
 * 画面上那条斜线正好穿过障碍的角，狗实际上过不去。
 */
export function searchPgmPath(
  grid: OctomapPgmGrid,
  start: number,
  goal: number,
): PgmSearchResult {
  if (start === goal) {
    return { cells: [start], best: start, reachedCells: [start] };
  }
  const width = grid.width;
  const height = grid.height;
  const blocked = grid.blocked;
  const goalCol = goal % width;
  const goalRow = (goal / width) | 0;

  const octile = (node: number): number => {
    const dx = Math.abs((node % width) - goalCol);
    const dy = Math.abs(((node / width) | 0) - goalRow);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };

  const count = width * height;
  const gScore = new Float32Array(count).fill(Infinity);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  gScore[start] = 0;

  const open = new MinHeap<[number, number]>((a, b) => a[0] - b[0]);
  open.push([octile(start), start]);

  const offsets: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  let best = start;
  let bestH = octile(start);
  while (open.size > 0) {
    const [, current] = open.pop()!;
    if (closed[current]) {
      continue;
    }
    closed[current] = 1;
    const h = octile(current);
    if (h < bestH) {
      bestH = h;
      best = current;
    }
    if (current === goal) {
      break;
    }

    const col = current % width;
    const row = (current / width) | 0;
    const currentG = gScore[current];
    for (const [dc, dr] of offsets) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= width || r < 0 || r >= height) {
        continue;
      }
      const neighbor = r * width + c;
      if (blocked[neighbor] !== 0 || closed[neighbor]) {
        continue;
      }
      if (dc !== 0 && dr !== 0) {
        // 不允许贴着障碍角切过去。
        if (blocked[row * width + c] !== 0 || blocked[r * width + col] !== 0) {
          continue;
        }
      }
      const tentative = currentG + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1);
      if (tentative < gScore[neighbor]) {
        gScore[neighbor] = tentative;
        cameFrom[neighbor] = current;
        open.push([tentative + octile(neighbor), neighbor]);
      }
    }
  }

  const reachedCells = chainFromStart(start, best, cameFrom);
  const cells = closed[goal] ? chainFromStart(start, goal, cameFrom) : null;
  return { cells, best, reachedCells };
}

/** 只关心「有没有路」的旧入口。 */
export function findPgmPath(
  grid: OctomapPgmGrid,
  start: number,
  goal: number,
): number[] | null {
  return searchPgmPath(grid, start, goal).cells;
}

/** 沿 `cameFrom` 从 `end` 倒推到 `start`，再翻成正序。 */
function chainFromStart(
  start: number,
  end: number,
  cameFrom: Int32Array,
): number[] {
  const cells: number[] = [];
  let cursor = end;
  while (cursor !== start) {
    cells.push(cursor);
    cursor = cameFrom[cursor];
  }
  cells.push(start);
  cells.reverse();
  return cells;
}

/**
 * 把 A* 的逐格折线拉直：从当前顶点尽量往前跳，只要两点之间的直线不碰障碍。
 *
 * 八邻 A* 在平地上给出的每一步方向只取决于代价，同一组方向的不同先后完全等价，
 * 于是折线会带出左右翻号的锯齿。拉直不改变「能不能走」——它只删掉中间那些本来
 * 就落在同一条无碰直线上的顶点——但会让小狗少拐很多次头。
 */
export function smoothPgmPath(grid: OctomapPgmGrid, cells: number[]): number[] {
  if (cells.length <= 2) {
    return cells;
  }
  const out: number[] = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let best = i + 1;
    for (let j = i + 2; j < cells.length; j++) {
      if (j - i > MAX_SMOOTH_CELLS || !lineClear(grid, cells[i], cells[j])) {
        break;
      }
      best = j;
    }
    out.push(cells[best]);
    i = best;
  }
  return out;
}

/** 两格心之间的直线是否整段可通行（含两端）。 */
function lineClear(grid: OctomapPgmGrid, a: number, b: number): boolean {
  const ac = a % grid.width;
  const ar = (a / grid.width) | 0;
  const bc = b % grid.width;
  const br = (b / grid.width) | 0;
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(bc - ac), Math.abs(br - ar)) * LINE_SAMPLES_PER_CELL),
  );
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const col = Math.round(ac + (bc - ac) * t);
    const row = Math.round(ar + (br - ar) * t);
    if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) {
      return false;
    }
    if (grid.blocked[row * grid.width + col] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * 格索引 → 世界坐标（格心）。
 *
 * 图像行号从上往下涨，而 Z 轴朝上：第 0 行对应 Z 最大的一侧，所以 `row` 要先翻成
 * `height - 1 - row` 再加半格。Y 取地面高度——二维规划不产生高度，路径就画在那个
 * 平面上。
 */
export function pgmCellToWorld(
  grid: OctomapPgmGrid,
  cell: number,
): [number, number, number] {
  const col = cell % grid.width;
  const row = (cell / grid.width) | 0;
  return [
    grid.minX + (col + 0.5) * grid.resolution,
    grid.groundLevel,
    grid.minZ + (grid.height - 1 - row + 0.5) * grid.resolution,
  ];
}

/**
 * 世界坐标 (X, Z) → 格索引；落在网格之外返回 null。
 *
 * 这是 {@link pgmCellToWorld} 的逆。宿主（导航页）拿它把三维视图里的位置换算到
 * 二维图上时，也必须遵守「第 0 行是 Z 最大」这一条。
 */
export function pgmWorldToCell(
  grid: OctomapPgmGrid,
  x: number,
  z: number,
): number | null {
  const col = Math.floor((x - grid.minX) / grid.resolution);
  const zCell = Math.floor((z - grid.minZ) / grid.resolution);
  if (col < 0 || col >= grid.width || zCell < 0 || zCell >= grid.height) {
    return null;
  }
  return (grid.height - 1 - zCell) * grid.width + col;
}
