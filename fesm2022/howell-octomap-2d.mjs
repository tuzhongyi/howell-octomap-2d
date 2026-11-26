import * as i0 from '@angular/core';
import { EventEmitter, viewChild, signal, effect, Output, Input, ChangeDetectionStrategy, Component } from '@angular/core';

/** 两档口径在界面上的短名与说明。 */
const OCTO_MAP_PGM_MODE_LABELS = {
    occupiedWalkable: {
        label: '黑格可走',
        hint: '黑色（有点）可走，白色是障碍；碰撞半径从白色一侧往里让。',
    },
    freeWalkable: {
        label: '白格可走',
        hint: '标准占用图：白色可走，黑色（墙）与灰色（未知）都是障碍。',
    },
};
/** PGM 文件头里没有比例尺，一格按多少米算由宿主指定；这是默认值。 */
const OCTO_MAP_PGM_DEFAULT_RESOLUTION = 0.05;
/**
 * 小狗碰撞半径的默认值（米）。
 *
 * 二维库不依赖三维库，所以这里保留与三维默认设置相同的数值（0.25 m）。
 */
const OCTO_MAP_PGM_DEFAULT_DOG_RADIUS = 0.25;
/**
 * 终点范围的默认值（米）。
 *
 * 与三维默认设置相同（0.5 m）；起点吸附范围默认也取这个值。
 */
const OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS = 0.5;

/**
 * 俯视地图的 PGM 编解码器：写出的是二进制 (P5)，读入兼容 P2 / P5，灰度使用
 * map-server 惯用的 0（占用）/ 254（空闲）两档。
 */
/** 黑色——点云的该列中存在点。 */
const PGM_OCCUPIED = 0;
/** 白色——点云的该列为空。 */
const PGM_FREE = 254;
/**
 * 灰度不高于这个值的像素算「黑」。
 *
 * 编码器只写 0 / 254，所以这个阈值在本仓的图上不会产生歧义；放宽到 127 是为了
 * 接住别处导出的地图（map-server 里还有 205 的未知格，它落在「不黑」的一侧）。
 */
const PGM_DARK_MAX = 127;
/**
 * 灰度不低于这个值的像素算「白」——空闲。
 *
 * 与 {@link PGM_DARK_MAX} 之间留出的中间档是「未知」（map-server 写 205）。标准
 * occupancy 图不建议把未知当空闲，所以「白格可走」只认真正的白，中间档照样是障碍。
 */
const PGM_FREE_MIN = 250;
/**
 * 把投影序列化为二进制 (P5) PGM 文件。
 *
 * `resolution` 可省略；给了就写进注释行，读回来时可以自动恢复比例尺。PGM 标准
 * 没有这个字段，但注释行允许任意内容，看图的软件会忽略它。
 */
function encodePgm(projection, resolution) {
    const scaleText = resolution !== undefined && resolution > 0 ? ` resolution=${resolution} m/cell` : '';
    const header = new TextEncoder().encode(`P5\n# octomap top-down projection (0=occupied, 254=free)${scaleText}\n` +
        `${projection.width} ${projection.height}\n255\n`);
    const out = new Uint8Array(new ArrayBuffer(header.length + projection.data.length));
    out.set(header, 0);
    out.set(projection.data, header.length);
    return out;
}
/**
 * 读入 PGM 文件（P2 文本 / P5 二进制），灰度统一归一化到 0..255。
 *
 * 只认 PGM 自己的头：宽、高、最大灰度。标准头里没有比例尺（map-server 把它放在
 * 同名 YAML 里）；本仓导出时把 `resolution=` 写进了注释行，读到就放进结果的
 * {@link OctoMapProjection.resolution}，读不到就留给宿主另给。
 */
function decodePgm(buffer) {
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    /** 头部的注释行；本仓的编码器会把比例尺写在这里。 */
    const comments = [];
    const decoder = new TextDecoder();
    const isSpace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
    /** 跳过空白与 `#` 注释，停在第一个有效字节上。 */
    const skipBlank = () => {
        while (offset < bytes.length) {
            const byte = bytes[offset];
            if (byte === 0x23) {
                offset++;
                const start = offset;
                while (offset < bytes.length && bytes[offset] !== 0x0a) {
                    offset++;
                }
                comments.push(decoder.decode(bytes.subarray(start, offset)).trim());
            }
            else if (isSpace(byte)) {
                offset++;
            }
            else {
                return;
            }
        }
    };
    const readToken = () => {
        skipBlank();
        const start = offset;
        while (offset < bytes.length && !isSpace(bytes[offset]) && bytes[offset] !== 0x23) {
            offset++;
        }
        return decoder.decode(bytes.subarray(start, offset));
    };
    const magic = readToken();
    if (magic !== 'P2' && magic !== 'P5') {
        throw new Error(`不是 PGM 文件（文件头是「${magic || '空'}」，应为 P2 或 P5）`);
    }
    const width = Number(readToken());
    const height = Number(readToken());
    const maxval = Number(readToken());
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error(`PGM 尺寸无效：${width} × ${height}`);
    }
    if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 65535) {
        throw new Error(`PGM 最大灰度无效：${maxval}`);
    }
    const count = width * height;
    const data = new Uint8Array(count);
    const result = { width, height, data };
    const resolution = readResolution(comments);
    if (resolution !== undefined) {
        result.resolution = resolution;
    }
    if (magic === 'P2') {
        for (let i = 0; i < count; i++) {
            const token = readToken();
            const value = Number(token);
            if (token === '' || !Number.isFinite(value)) {
                throw new Error(`PGM 数据不足：只读到 ${i} / ${count} 个像素`);
            }
            data[i] = normalizeSample(value, maxval);
        }
        return result;
    }
    // P5：头之后恰好一个空白字符，随后就是原始像素。不能多跳空白——0x20 / 0x0a
    // 本身也是合法的灰度值。只有分隔符自己是 `\r`（CRLF 文件）时才连 `\n` 一起跳；
    // 判断依据必须是**分隔符**，不能看前两个像素字节，否则像素恰好是 13、10 时会被
    // 多吞掉一个。
    if (offset >= bytes.length) {
        throw new Error('PGM 缺少像素数据');
    }
    if (bytes[offset] === 0x0d) {
        offset++;
        if (bytes[offset] === 0x0a) {
            offset++;
        }
    }
    else {
        offset++;
    }
    const sampleBytes = maxval < 256 ? 1 : 2;
    const needed = count * sampleBytes;
    if (bytes.length - offset < needed) {
        throw new Error(`PGM 数据不足：需要 ${needed} 字节，只有 ${bytes.length - offset}`);
    }
    if (sampleBytes === 1) {
        data.set(bytes.subarray(offset, offset + count));
    }
    else {
        for (let i = 0; i < count; i++) {
            const high = bytes[offset + i * 2];
            const low = bytes[offset + i * 2 + 1];
            data[i] = normalizeSample((high << 8) | low, maxval);
        }
    }
    return result;
}
/** 从注释行里找本仓写的 `resolution=0.4 m/cell`；没有就返回 undefined。 */
function readResolution(comments) {
    for (const comment of comments) {
        const match = /resolution\s*=\s*([0-9]*\.?[0-9]+)/i.exec(comment);
        if (match) {
            const value = Number(match[1]);
            if (Number.isFinite(value) && value > 0) {
                return value;
            }
        }
    }
    return undefined;
}
/** 16 位或非 255 上限的灰度映射到 0..255。 */
function normalizeSample(value, maxval) {
    if (maxval === 255) {
        return Math.max(0, Math.min(255, value));
    }
    return Math.max(0, Math.min(255, Math.round((value * 255) / maxval)));
}

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
class MinHeap {
    compare;
    items = [];
    constructor(compare) {
        this.compare = compare;
    }
    get size() {
        return this.items.length;
    }
    push(item) {
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
    pop() {
        if (this.items.length === 0) {
            return undefined;
        }
        const top = this.items[0];
        const last = this.items.pop();
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
function buildPgmGrid(image, options) {
    const scale = downsampleScale(image.width, image.height);
    const resolution = options.resolution * scale;
    // 先在原图上按口径标出障碍。两档都只认两端：`occupiedWalkable` 只放行黑，
    // `freeWalkable` 只放行白；介于两者之间的「未知」灰两边都算障碍。
    const sourceBlocked = new Uint8Array(image.data.length);
    for (let i = 0; i < sourceBlocked.length; i++) {
        const value = image.data[i];
        if (options.mode === 'occupiedWalkable') {
            sourceBlocked[i] = value <= PGM_DARK_MAX ? 0 : 1;
        }
        else {
            sourceBlocked[i] = value <= PGM_DARK_MAX || value < PGM_FREE_MIN ? 1 : 0;
        }
    }
    const width = Math.max(1, Math.ceil(image.width / scale));
    const height = Math.max(1, Math.ceil(image.height / scale));
    const rawBlocked = scale === 1
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
function downsampleScale(width, height) {
    let scale = 1;
    while (Math.ceil(width / scale) * Math.ceil(height / scale) > MAX_PGM_CELLS) {
        scale++;
    }
    return scale;
}
/** 把 `scale × scale` 的像素块压成一格：块里只要有一个障碍，这一格就是障碍。 */
function reduceBlocked(source, sourceWidth, sourceHeight, width, height, scale) {
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
function inflateBlocked(rawBlocked, width, height, dogRadius, resolution) {
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
function planPgmPath(grid, start, goal, goalRadius, startRadius = goalRadius, startClearance = null) {
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
    const startMask = startClearance !== null && startClearance > grid.dogRadius
        ? inflateBlocked(grid.rawBlocked, grid.width, grid.height, startClearance, grid.resolution)
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
function pathOf(grid, cells) {
    const world = cells.map((cell) => pgmCellToWorld(grid, cell));
    let length = 0;
    for (let i = 1; i < world.length; i++) {
        length += Math.hypot(world[i][0] - world[i - 1][0], world[i][1] - world[i - 1][1], world[i][2] - world[i - 1][2]);
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
function snapToFree(grid, cell, maxCells, blocked = grid.blocked) {
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
function searchPgmPath(grid, start, goal) {
    if (start === goal) {
        return { cells: [start], best: start, reachedCells: [start] };
    }
    const width = grid.width;
    const height = grid.height;
    const blocked = grid.blocked;
    const goalCol = goal % width;
    const goalRow = (goal / width) | 0;
    const octile = (node) => {
        const dx = Math.abs((node % width) - goalCol);
        const dy = Math.abs(((node / width) | 0) - goalRow);
        return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    const count = width * height;
    const gScore = new Float32Array(count).fill(Infinity);
    const cameFrom = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    gScore[start] = 0;
    const open = new MinHeap((a, b) => a[0] - b[0]);
    open.push([octile(start), start]);
    const offsets = [
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
        const [, current] = open.pop();
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
function findPgmPath(grid, start, goal) {
    return searchPgmPath(grid, start, goal).cells;
}
/** 沿 `cameFrom` 从 `end` 倒推到 `start`，再翻成正序。 */
function chainFromStart(start, end, cameFrom) {
    const cells = [];
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
function smoothPgmPath(grid, cells) {
    if (cells.length <= 2) {
        return cells;
    }
    const out = [cells[0]];
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
function lineClear(grid, a, b) {
    const ac = a % grid.width;
    const ar = (a / grid.width) | 0;
    const bc = b % grid.width;
    const br = (b / grid.width) | 0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bc - ac), Math.abs(br - ar)) * LINE_SAMPLES_PER_CELL));
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
function pgmCellToWorld(grid, cell) {
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
function pgmWorldToCell(grid, x, z) {
    const col = Math.floor((x - grid.minX) / grid.resolution);
    const zCell = Math.floor((z - grid.minZ) / grid.resolution);
    if (col < 0 || col >= grid.width || zCell < 0 || zCell >= grid.height) {
        return null;
    }
    return (grid.height - 1 - zCell) * grid.width + col;
}

/**
 * 在一张 PGM 地图上做二维寻路。
 *
 * 输入是一张已经解码好的灰度图 {@link OctoMapProjection}，加一格多少米。建图、膨胀、
 * A*、拉直全在这个目录里，不碰 Three.js、不碰 octo-map 的三维控制器；宿主只负责
 * 把文件读成像素。这样同一份算法既能给 `/system/pgm` 的二维页用，也能在测试里直接
 * `new` 一个网格跑。
 *
 * 与三维寻路共用的是**小狗的形状**：`dogRadius` 决定障碍外扩多少，`goalRadius`
 * 决定终点歪了之后最多吸附多远。二维平面里没有高度与天花板，`maxStepHeight` /
 * `dogHeight` 不参与判定。
 *
 * 交互：左键设起点、右键设终点；**点了「开始寻址」才计算**。点完两个端点后路线不会
 * 自己冒出来，调参数也不会悄悄重算——参数改过就把旧结果清掉，让用户知道该再点一次。
 * 走不通时不只是报错：A* 记下能走到的最远处，面板和画布会标出卡在哪一格。
 */
class Octomap2dPgmComponent {
    /** 要寻路的 PGM 图像；为空时只显示一句提示。 */
    image = null;
    /** 一格对应多少米。PGM 文件头不带比例尺，只能由宿主给。 */
    resolution = OCTO_MAP_PGM_DEFAULT_RESOLUTION;
    /** 小狗碰撞半径（米），决定障碍往外膨胀多少。 */
    dogRadius = OCTO_MAP_PGM_DEFAULT_DOG_RADIUS;
    /** 终点范围（米）：点中的格子不可通行时，最多吸附这么远。 */
    goalRadius = OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS;
    /**
     * 初始通行口径。切换之后由组件自己记（并发出 {@link modeChange}）；父组件再改
     * 这个输入会覆盖当前选择。
     *
     * 默认「黑格可走」，与本仓导出的 PGM 对齐：那里的黑 = 该列有点，正是小狗要走的
     * 地面；从 map-server 换来、墙画成黑色的地图在工具条上切到「白格可走」即可。
     */
    mode = 'occupiedWalkable';
    /** 用户切换通行口径时发出。 */
    modeChange = new EventEmitter();
    /** 每次「开始寻址」或清除时发出，供宿主显示或转交。 */
    pathChange = new EventEmitter();
    canvasRef = viewChild('canvas', ...(ngDevMode ? [{ debugName: "canvasRef" }] : /* istanbul ignore next */ []));
    /** 当前通行口径。输入只是初值，选择器改的是这个。 */
    activeMode = signal('occupiedWalkable', ...(ngDevMode ? [{ debugName: "activeMode" }] : /* istanbul ignore next */ []));
    /** 当前网格；`image` 为空、分辨率无效或建图失败时为空。 */
    grid = signal(null, ...(ngDevMode ? [{ debugName: "grid" }] : /* istanbul ignore next */ []));
    /** 用户点中的起点 / 终点格（吸附前的原始格）。 */
    startCell = signal(null, ...(ngDevMode ? [{ debugName: "startCell" }] : /* istanbul ignore next */ []));
    goalCell = signal(null, ...(ngDevMode ? [{ debugName: "goalCell" }] : /* istanbul ignore next */ []));
    /** 最近一次「开始寻址」的结果；null 表示还没算，或端点 / 参数已经改过。 */
    plan = signal(null, ...(ngDevMode ? [{ debugName: "plan" }] : /* istanbul ignore next */ []));
    /** 起点圆点半径（格）。只影响画出来的标记，不参与寻路。 */
    markerSize = signal(10, ...(ngDevMode ? [{ debugName: "markerSize" }] : /* istanbul ignore next */ []));
    /** 起点吸附范围（米）：点中的起点不可走时，最多找这么远。默认跟终点范围一致。 */
    startSnapRadius = signal(OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS, ...(ngDevMode ? [{ debugName: "startSnapRadius" }] : /* istanbul ignore next */ []));
    /**
     * 起点要求的最小净空（米）。比建图时的碰撞半径更严时，起点会被推到离障碍更远的
     * 格子上；小于等于 `dogRadius` 时不生效（路线本身仍按碰撞半径膨胀）。
     */
    startClearance = signal(OCTO_MAP_PGM_DEFAULT_DOG_RADIUS, ...(ngDevMode ? [{ debugName: "startClearance" }] : /* istanbul ignore next */ []));
    /** 面板里的值一旦被用户改过，就不要再被宿主的新输入或自动默认值覆盖。 */
    startRadiusTouched = false;
    clearanceTouched = false;
    markerTouched = false;
    modeOptions = Object.keys(OCTO_MAP_PGM_MODE_LABELS).map((value) => ({ value, ...OCTO_MAP_PGM_MODE_LABELS[value] }));
    /** 表单事件只放需要从 DOM 上取值的处理器。 */
    on = {
        mode: (event) => {
            this.setMode(event.target.value);
        },
        markerSize: (event) => {
            this.markerTouched = true;
            this.markerSize.set(readNumber(event, this.markerSize(), 1));
        },
        startSnapRadius: (event) => {
            this.startRadiusTouched = true;
            this.startSnapRadius.set(readNumber(event, this.startSnapRadius(), 0));
            this.clearPlan();
        },
        startClearance: (event) => {
            this.clearanceTouched = true;
            this.startClearance.set(readNumber(event, this.startClearance(), 0));
            this.clearPlan();
        },
    };
    constructor() {
        effect(() => this.draw());
    }
    ngOnChanges(changes) {
        let rebuild = false;
        if (changes['image']) {
            // 换了一张图，旧的起终点指的是另一张图上的格子，留着只会画出一条莫名其妙的线。
            this.startCell.set(null);
            this.goalCell.set(null);
            rebuild = true;
        }
        if (changes['mode']) {
            this.activeMode.set(this.mode);
            rebuild = true;
        }
        if (changes['dogRadius']) {
            if (!this.clearanceTouched) {
                this.startClearance.set(this.dogRadius);
            }
            rebuild = true;
        }
        if (changes['resolution']) {
            rebuild = true;
        }
        if (changes['goalRadius']) {
            if (!this.startRadiusTouched) {
                this.startSnapRadius.set(this.goalRadius);
            }
            // 终点范围参与规划，换了就得重算，旧结果不能留。
            this.clearPlan();
        }
        if (rebuild) {
            this.rebuild();
        }
    }
    /** 当前口径的说明，显示在图例旁边。 */
    modeHint() {
        return OCTO_MAP_PGM_MODE_LABELS[this.activeMode()].hint;
    }
    /** 网格尺寸与分辨率，显示在工具条上。 */
    gridInfo() {
        const grid = this.grid();
        if (!grid) {
            return null;
        }
        return `${grid.width} × ${grid.height} 格 · 每格 ${(grid.resolution * 100).toFixed(2)} cm`;
    }
    /** 起点坐标。算过之后显示实际落脚点（吸附后的），否则显示点中的位置。 */
    startText() {
        return this.coordText(this.plan()?.startCell ?? this.startCell());
    }
    /** 终点坐标。算过之后显示实际落点。 */
    goalText() {
        return this.coordText(this.plan()?.goalCell ?? this.goalCell());
    }
    /** 两个端点都有、且地图可用时才让点「开始寻址」。 */
    canSearch() {
        return this.grid() !== null && this.startCell() !== null && this.goalCell() !== null;
    }
    /** 一句状态：缺什么、为什么失败、或者路多长。 */
    statusText() {
        const grid = this.grid();
        if (!grid) {
            return '没有可用的 PGM 地图。先在工具条上加载一个 .pgm 文件。';
        }
        const plan = this.plan();
        if (!plan) {
            if (this.startCell() === null) {
                return '左键在图上点一下设起点。';
            }
            if (this.goalCell() === null) {
                return '右键在图上点一下设终点。';
            }
            return '点「开始寻址」计算路线。';
        }
        switch (plan.reason) {
            case 'noStart':
                return '左键在图上点一下设起点。';
            case 'noGoal':
                return '右键在图上点一下设终点。';
            case 'blockedStart':
                return `起点附近 ${this.startSnapRadius().toFixed(2)} m 内没有${this.clearanceHint()}可通行的格子。`;
            case 'blockedGoal':
                return `终点附近 ${this.goalRadius.toFixed(2)} m 内没有可通行的格子。`;
            case 'unreachable':
                return this.unreachableText(grid, plan);
            default:
                break;
        }
        if (plan.path) {
            const snapped = [];
            if (plan.startSnapped) {
                snapped.push('起点');
            }
            if (plan.goalSnapped) {
                snapped.push('终点');
            }
            const snapText = snapped.length > 0 ? `（${snapped.join('、')}已吸附到最近的可通行格）` : '';
            return `路径 ${plan.path.cells.length} 点 · 长 ${plan.path.length.toFixed(2)} m${snapText}`;
        }
        return '';
    }
    setMode(value) {
        const mode = value;
        if (mode === this.activeMode()) {
            return;
        }
        this.activeMode.set(mode);
        this.modeChange.emit(mode);
        this.rebuild();
    }
    /** 用户按下「开始寻址」：这时才真的跑一次规划。 */
    runSearch() {
        const grid = this.grid();
        if (!grid) {
            return;
        }
        const plan = planPgmPath(grid, this.startCell(), this.goalCell(), this.goalRadius, this.startSnapRadius(), this.startClearance());
        this.plan.set(plan);
        this.pathChange.emit(plan);
    }
    clearMarks() {
        this.startCell.set(null);
        this.goalCell.set(null);
        this.clearPlan();
    }
    onPointerDown(event) {
        const grid = this.grid();
        if (!grid) {
            return;
        }
        const cell = this.cellFromEvent(event, grid);
        if (cell === null) {
            return;
        }
        event.preventDefault();
        if (event.button === 2) {
            this.goalCell.set(cell);
        }
        else if (event.button === 0) {
            this.startCell.set(cell);
        }
        else {
            return;
        }
        // 端点换了，旧路线就作废；按钮仍在，用户想算再点一次。
        this.clearPlan();
    }
    onContextMenu(event) {
        // 右键用来设终点，不能让浏览器菜单盖上来。
        event.preventDefault();
    }
    rebuild() {
        this.clearPlan();
        const image = this.image;
        // 分辨率为 0 或 NaN 时膨胀半径会变成 Infinity，整张图都会被判成障碍——宁可
        // 退回「没有地图」，等宿主把数字改对。
        if (!image || !(this.resolution > 0)) {
            this.grid.set(null);
            return;
        }
        const grid = buildPgmGrid(image, {
            mode: this.activeMode(),
            dogRadius: this.dogRadius,
            resolution: this.resolution,
        });
        this.grid.set(grid);
        if (!this.markerTouched) {
            // 默认圆点跟着地图大小走：小图不至于糊住起点，大图也不至于看不见。
            this.markerSize.set(autoMarkerSize(grid));
        }
    }
    /** 清掉旧结果；没有结果时什么也不发。 */
    clearPlan() {
        if (this.plan() === null) {
            return;
        }
        this.plan.set(null);
        this.pathChange.emit(null);
    }
    /** 格索引 → 面板上的 `(x, z)`；没有格或没有网格时显示「未设置」。 */
    coordText(cell) {
        const grid = this.grid();
        if (!grid || cell === null) {
            return '未设置';
        }
        const world = pgmCellToWorld(grid, cell);
        return `(${world[0].toFixed(2)}, ${world[2].toFixed(2)})`;
    }
    /** 起点净空比碰撞半径更严时，失败提示里说明是哪一套口径卡住了。 */
    clearanceHint() {
        return this.startClearance() > this.dogRadius ? '满足起点净空的' : '';
    }
    /** 走不通时的一句话：最远到哪、还差多远、残段多长。 */
    unreachableText(grid, plan) {
        if (plan.stuckCell === null || plan.goalCell === null) {
            return '走不通：两点之间没有可行路线（障碍或碰撞膨胀把路封住了）。';
        }
        const stuck = pgmCellToWorld(grid, plan.stuckCell);
        const goal = pgmCellToWorld(grid, plan.goalCell);
        const gap = Math.hypot(goal[0] - stuck[0], goal[2] - stuck[2]);
        const walked = plan.partialPath?.length ?? 0;
        return (`走不通：走到 (${stuck[0].toFixed(2)}, ${stuck[2].toFixed(2)}) 被挡住，` +
            `离终点还有 ${gap.toFixed(2)} m（残段 ${walked.toFixed(2)} m）。`);
    }
    /** 指针位置 → 网格格索引；落在画布之外返回 null。 */
    cellFromEvent(event, grid) {
        const canvas = this.canvasRef()?.nativeElement;
        if (!canvas) {
            return null;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        // 画布在 CSS 里是 `width/height: 100% + object-fit: contain`：元素盒子铺满容器，
        // 图本身按比例居中留边。指针换算必须用**图的内容框**，不能用元素矩形，否则
        // 长宽比不一致时点哪儿都偏。
        const scale = Math.min(rect.width / grid.width, rect.height / grid.height);
        if (scale <= 0) {
            return null;
        }
        const offsetX = rect.left + (rect.width - grid.width * scale) / 2;
        const offsetY = rect.top + (rect.height - grid.height * scale) / 2;
        const col = Math.floor((event.clientX - offsetX) / scale);
        const row = Math.floor((event.clientY - offsetY) / scale);
        if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) {
            return null;
        }
        return row * grid.width + col;
    }
    /**
     * 把网格、路径和两个端点画到画布上。
     *
     * 画布的内部分辨率就是网格的格数，CSS 再把它拉到容器大小：这样每个像素对应一格，
     * 指针换算只要一个比例，不需要沿路反投影。放大用 `image-rendering: pixelated`，
     * 免得浏览器把 5 cm 的格子插值成一片糊。
     *
     * 走不通时多画三样东西：红色残段（从起点到最远处）、卡住点的红叉、以及从卡点到
     * 终点的虚线——虚线标出的是最后没打通的那一段，不是路。
     */
    draw() {
        const canvas = this.canvasRef()?.nativeElement;
        if (!canvas) {
            return;
        }
        const grid = this.grid();
        if (!grid) {
            canvas.width = 1;
            canvas.height = 1;
            return;
        }
        if (canvas.width !== grid.width || canvas.height !== grid.height) {
            canvas.width = grid.width;
            canvas.height = grid.height;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        const image = context.createImageData(grid.width, grid.height);
        const data = image.data;
        for (let i = 0; i < grid.blocked.length; i++) {
            const p = i * 4;
            if (grid.rawBlocked[i] !== 0) {
                // 原始障碍：深灰，不用纯黑——路径与端点要压在上面才看得清。
                data[p] = 31;
                data[p + 1] = 41;
                data[p + 2] = 55;
            }
            else if (grid.blocked[i] !== 0) {
                // 只因为碰撞半径而不可走的格子：浅红。调小半径时它会缩回去，用户能直接
                // 看到「小狗的碰撞」在二维图上值多少格。
                data[p] = 254;
                data[p + 1] = 202;
                data[p + 2] = 202;
            }
            else {
                data[p] = 248;
                data[p + 1] = 250;
                data[p + 2] = 252;
            }
            data[p + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const plan = this.plan();
        const thinLine = Math.max(1.2, Math.min(grid.width, grid.height) / 220);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        if (plan?.path) {
            const points = cellPoints(grid, plan.path.cells);
            // 白色描边垫底：路径经过深灰障碍边缘时仍然看得见。
            context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            context.lineWidth = Math.max(2.5, Math.min(grid.width, grid.height) / 90);
            tracePath(context, points);
            context.stroke();
            context.strokeStyle = '#2563eb';
            context.lineWidth = thinLine;
            tracePath(context, points);
            context.stroke();
        }
        const partial = plan?.partialPath;
        if (partial && partial.cells.length > 1) {
            const points = cellPoints(grid, partial.cells);
            context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            context.lineWidth = Math.max(2.5, Math.min(grid.width, grid.height) / 90);
            tracePath(context, points);
            context.stroke();
            context.strokeStyle = '#dc2626';
            context.lineWidth = thinLine;
            tracePath(context, points);
            context.stroke();
        }
        if (plan && plan.stuckCell !== null && plan.goalCell !== null) {
            // 卡点 → 终点：虚线只表示「差的这一段没打通」，不能当成可走路线。
            const from = cellCenter(grid, plan.stuckCell);
            const to = cellCenter(grid, plan.goalCell);
            context.save();
            const dash = Math.max(2, Math.min(grid.width, grid.height) / 100);
            context.setLineDash([dash, dash]);
            context.strokeStyle = 'rgba(220, 38, 38, 0.75)';
            context.lineWidth = Math.max(1, Math.min(grid.width, grid.height) / 300);
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.stroke();
            context.restore();
        }
        // 点下就画。只设了一个端点时 `plan` 还是为空，只看 plan 的话第一下点击没有
        // 任何反馈；这里以用户原始点中的格为准，吸附成功时仍画在路径真正的落点上。
        const start = this.startCell();
        const goal = this.goalCell();
        if (start !== null) {
            drawMarker(context, grid, plan?.startCell ?? start, '#16a34a', this.startClearance(), this.markerSize());
        }
        if (goal !== null) {
            drawMarker(context, grid, plan?.goalCell ?? goal, '#f59e0b', 0);
        }
        if (plan && plan.stuckCell !== null) {
            drawStuckCross(context, grid, plan.stuckCell);
        }
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap2dPgmComponent, deps: [], target: i0.ɵɵFactoryTarget.Component });
    static ɵcmp = i0.ɵɵngDeclareComponent({ minVersion: "17.0.0", version: "21.2.26", type: Octomap2dPgmComponent, isStandalone: true, selector: "howell-octomap-2d-pgm", inputs: { image: "image", resolution: "resolution", dogRadius: "dogRadius", goalRadius: "goalRadius", mode: "mode" }, outputs: { modeChange: "modeChange", pathChange: "pathChange" }, viewQueries: [{ propertyName: "canvasRef", first: true, predicate: ["canvas"], descendants: true, isSignal: true }], usesOnChanges: true, ngImport: i0, template: "<section class=\"octomap-2d-pgm\">\n  <header class=\"octomap-2d-pgm__bar\">\n    <label class=\"octomap-2d-pgm__field\">\n      <span class=\"octomap-2d-pgm__label\">\u901A\u884C\u53E3\u5F84</span>\n      <select class=\"octomap-2d-pgm__control\" [value]=\"activeMode()\" (change)=\"on.mode($event)\">\n        @for (option of modeOptions; track option.value) {\n          <option [value]=\"option.value\">{{ option.label }}</option>\n        }\n      </select>\n    </label>\n\n    <span class=\"octomap-2d-pgm__readout\">\u78B0\u649E\u534A\u5F84 {{ dogRadius.toFixed(2) }} m</span>\n    <span class=\"octomap-2d-pgm__readout\">\u6BCF\u683C {{ resolution.toFixed(2) }} m</span>\n    <span class=\"octomap-2d-pgm__readout\">\u7EC8\u70B9\u8303\u56F4 {{ goalRadius.toFixed(2) }} m</span>\n\n    @if (gridInfo(); as info) {\n      <span class=\"octomap-2d-pgm__info\">{{ info }}</span>\n    }\n  </header>\n\n  <div class=\"octomap-2d-pgm__main\">\n    <aside class=\"octomap-2d-pgm__panel\">\n      <h2 class=\"octomap-2d-pgm__panel-title\">\u5BFB\u8DEF</h2>\n\n      <div class=\"octomap-2d-pgm__coords\">\n        <div class=\"octomap-2d-pgm__coord\">\n          <span class=\"octomap-2d-pgm__coord-label\">\n            <span class=\"octomap-2d-pgm__dot octomap-2d-pgm__dot--start\"></span>\u8D77\u70B9\n          </span>\n          <span class=\"octomap-2d-pgm__coord-value\">{{ startText() }}</span>\n        </div>\n        <div class=\"octomap-2d-pgm__coord\">\n          <span class=\"octomap-2d-pgm__coord-label\">\n            <span class=\"octomap-2d-pgm__dot octomap-2d-pgm__dot--goal\"></span>\u7EC8\u70B9\n          </span>\n          <span class=\"octomap-2d-pgm__coord-value\">{{ goalText() }}</span>\n        </div>\n      </div>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span class=\"octomap-2d-pgm__param-label\" title=\"\u53EA\u5F71\u54CD\u753B\u51FA\u6765\u7684\u5706\u70B9\u5927\u5C0F\uFF0C\u4E0D\u53C2\u4E0E\u5BFB\u8DEF\u3002\">\u8D77\u70B9\u5927\u5C0F\uFF08\u683C\uFF09</span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"1\"\n          step=\"1\"\n          [value]=\"markerSize()\"\n          (change)=\"on.markerSize($event)\"\n        />\n      </label>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span class=\"octomap-2d-pgm__param-label\" title=\"\u8D77\u70B9\u843D\u5728\u4E0D\u53EF\u8D70\u7684\u683C\u5B50\u4E0A\u65F6\uFF0C\u6700\u591A\u627E\u8FD9\u4E48\u8FDC\u843D\u811A\u3002\">\n          \u8D77\u70B9\u5438\u9644\uFF08m\uFF09\n        </span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"0\"\n          step=\"0.05\"\n          [value]=\"startSnapRadius()\"\n          (change)=\"on.startSnapRadius($event)\"\n        />\n      </label>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span\n          class=\"octomap-2d-pgm__param-label\"\n          title=\"\u8D77\u70B9\u5468\u56F4\u8981\u6C42\u7684\u6700\u5C0F\u51C0\u7A7A\uFF1B\u4E0D\u8D85\u8FC7\u5168\u5C40\u78B0\u649E\u534A\u5F84\u65F6\u4E0D\u751F\u6548\u3002\"\n        >\n          \u8D77\u70B9\u78B0\u649E\uFF08m\uFF09\n        </span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"0\"\n          step=\"0.05\"\n          [value]=\"startClearance()\"\n          (change)=\"on.startClearance($event)\"\n        />\n      </label>\n\n      <button\n        class=\"octomap-2d-pgm__button octomap-2d-pgm__button--go\"\n        type=\"button\"\n        [disabled]=\"!canSearch()\"\n        (click)=\"runSearch()\"\n      >\n        \u5F00\u59CB\u5BFB\u5740\n      </button>\n\n      <p class=\"octomap-2d-pgm__status\">{{ statusText() }}</p>\n\n      <button class=\"octomap-2d-pgm__button octomap-2d-pgm__button--ghost\" type=\"button\" (click)=\"clearMarks()\">\n        \u6E05\u9664\u8D77\u7EC8\u70B9\n      </button>\n    </aside>\n\n    <div class=\"octomap-2d-pgm__viewport\">\n      <canvas\n        #canvas\n        class=\"octomap-2d-pgm__canvas\"\n        [class.octomap-2d-pgm__canvas--empty]=\"!grid()\"\n        (pointerdown)=\"onPointerDown($event)\"\n        (contextmenu)=\"onContextMenu($event)\"\n      ></canvas>\n      @if (!grid()) {\n        <p class=\"octomap-2d-pgm__empty\">\u8FD8\u6CA1\u6709\u53EF\u7528\u7684 PGM \u5730\u56FE\u3002\u5148\u5728\u5DE5\u5177\u6761\u4E0A\u52A0\u8F7D\u4E00\u4E2A .pgm \u6587\u4EF6\u3002</p>\n      }\n    </div>\n  </div>\n\n  <div class=\"octomap-2d-pgm__legend\">\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--free\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u53EF\u8D70</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--obstacle\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u969C\u788D</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--inflated\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u78B0\u649E\u81A8\u80C0</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--path\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8DEF\u5F84</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--stuck\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8D70\u4E0D\u901A\uFF08\u6B8B\u6BB5 / \u5361\u70B9\uFF09</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--start\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8D77\u70B9\uFF08\u542B\u8DB3\u8FF9\uFF09</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--goal\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u7EC8\u70B9</span>\n\n    <span class=\"octomap-2d-pgm__hint\">\u5DE6\u952E\u8BBE\u8D77\u70B9\uFF0C\u53F3\u952E\u8BBE\u7EC8\u70B9\uFF0C\u7136\u540E\u70B9\u300C\u5F00\u59CB\u5BFB\u5740\u300D\u3002{{ modeHint() }}</span>\n  </div>\n</section>\n", styles: [":host{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color:#e6edf7;background:#0b1016;color-scheme:dark}.octomap-2d-pgm{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}.octomap-2d-pgm__bar{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:10px 16px;background:#141a24;border-bottom:1px solid #232b3a}.octomap-2d-pgm__field{display:flex;align-items:center;gap:8px}.octomap-2d-pgm__label{font-size:13px;color:#8b98ad}.octomap-2d-pgm__control{padding:6px 10px;font-size:13px;color:#e6edf7;background:#1d2635;border:1px solid #2a3448;border-radius:6px}.octomap-2d-pgm__readout{font-size:13px;color:#8b98ad;white-space:nowrap}.octomap-2d-pgm__info{margin-left:auto;font-size:12px;color:#6b7a91;white-space:nowrap}.octomap-2d-pgm__button{padding:7px 14px;font-size:13px;color:#e6edf7;background:#2b6cb0;border:none;border-radius:6px;cursor:pointer}.octomap-2d-pgm__button:hover:not(:disabled){background:#3380d0}.octomap-2d-pgm__button:disabled{color:#6b7a91;background:#263243;cursor:not-allowed}.octomap-2d-pgm__button--go{margin-top:4px;font-weight:600}.octomap-2d-pgm__button--ghost{background:transparent;color:#8b98ad;border:1px solid #2a3448}.octomap-2d-pgm__button--ghost:hover:not(:disabled){background:#1d2635;color:#e6edf7}.octomap-2d-pgm__main{display:flex;flex:1 1 auto;min-height:0}.octomap-2d-pgm__panel{flex:0 0 236px;display:flex;flex-direction:column;gap:10px;padding:14px;overflow-y:auto;background:#10161f;border-right:1px solid #232b3a}.octomap-2d-pgm__panel-title{margin:0;font-size:13px;font-weight:600;letter-spacing:.04em;color:#8b98ad}.octomap-2d-pgm__coords{display:flex;flex-direction:column;gap:6px;padding:10px;background:#141a24;border:1px solid #232b3a;border-radius:8px}.octomap-2d-pgm__coord{display:flex;justify-content:space-between;gap:8px;font-size:12px}.octomap-2d-pgm__coord-label{display:flex;align-items:center;gap:6px;color:#8b98ad}.octomap-2d-pgm__coord-value{color:#e6edf7;font-variant-numeric:tabular-nums}.octomap-2d-pgm__dot{width:8px;height:8px;border-radius:50%}.octomap-2d-pgm__dot--start{background:#16a34a}.octomap-2d-pgm__dot--goal{background:#f59e0b}.octomap-2d-pgm__param{display:flex;flex-direction:column;gap:4px}.octomap-2d-pgm__param-label{font-size:12px;color:#8b98ad}.octomap-2d-pgm__number{width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;color:#e6edf7;background:#1d2635;border:1px solid #2a3448;border-radius:6px}.octomap-2d-pgm__status{margin:0;font-size:12px;line-height:1.5;color:#aab6c8;word-break:break-word}.octomap-2d-pgm__viewport{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0b1016}.octomap-2d-pgm__canvas{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;cursor:crosshair}.octomap-2d-pgm__canvas--empty{display:none}.octomap-2d-pgm__empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;padding:24px;font-size:14px;color:#8b98ad;text-align:center}.octomap-2d-pgm__legend{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 16px 12px;background:#141a24}.octomap-2d-pgm__swatch{width:12px;height:12px;border-radius:3px;border:1px solid rgba(255,255,255,.18)}.octomap-2d-pgm__swatch--free{background:#f8fafc}.octomap-2d-pgm__swatch--obstacle{background:#1f2937}.octomap-2d-pgm__swatch--inflated{background:#fecaca}.octomap-2d-pgm__swatch--path{background:#2563eb}.octomap-2d-pgm__swatch--stuck{background:#dc2626}.octomap-2d-pgm__swatch--start{background:#16a34a}.octomap-2d-pgm__swatch--goal{background:#f59e0b}.octomap-2d-pgm__legend-text{font-size:12px;color:#8b98ad}.octomap-2d-pgm__hint{flex:1 1 100%;font-size:12px;color:#6b7a91}\n"], changeDetection: i0.ChangeDetectionStrategy.OnPush });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap2dPgmComponent, decorators: [{
            type: Component,
            args: [{ selector: 'howell-octomap-2d-pgm', imports: [], changeDetection: ChangeDetectionStrategy.OnPush, template: "<section class=\"octomap-2d-pgm\">\n  <header class=\"octomap-2d-pgm__bar\">\n    <label class=\"octomap-2d-pgm__field\">\n      <span class=\"octomap-2d-pgm__label\">\u901A\u884C\u53E3\u5F84</span>\n      <select class=\"octomap-2d-pgm__control\" [value]=\"activeMode()\" (change)=\"on.mode($event)\">\n        @for (option of modeOptions; track option.value) {\n          <option [value]=\"option.value\">{{ option.label }}</option>\n        }\n      </select>\n    </label>\n\n    <span class=\"octomap-2d-pgm__readout\">\u78B0\u649E\u534A\u5F84 {{ dogRadius.toFixed(2) }} m</span>\n    <span class=\"octomap-2d-pgm__readout\">\u6BCF\u683C {{ resolution.toFixed(2) }} m</span>\n    <span class=\"octomap-2d-pgm__readout\">\u7EC8\u70B9\u8303\u56F4 {{ goalRadius.toFixed(2) }} m</span>\n\n    @if (gridInfo(); as info) {\n      <span class=\"octomap-2d-pgm__info\">{{ info }}</span>\n    }\n  </header>\n\n  <div class=\"octomap-2d-pgm__main\">\n    <aside class=\"octomap-2d-pgm__panel\">\n      <h2 class=\"octomap-2d-pgm__panel-title\">\u5BFB\u8DEF</h2>\n\n      <div class=\"octomap-2d-pgm__coords\">\n        <div class=\"octomap-2d-pgm__coord\">\n          <span class=\"octomap-2d-pgm__coord-label\">\n            <span class=\"octomap-2d-pgm__dot octomap-2d-pgm__dot--start\"></span>\u8D77\u70B9\n          </span>\n          <span class=\"octomap-2d-pgm__coord-value\">{{ startText() }}</span>\n        </div>\n        <div class=\"octomap-2d-pgm__coord\">\n          <span class=\"octomap-2d-pgm__coord-label\">\n            <span class=\"octomap-2d-pgm__dot octomap-2d-pgm__dot--goal\"></span>\u7EC8\u70B9\n          </span>\n          <span class=\"octomap-2d-pgm__coord-value\">{{ goalText() }}</span>\n        </div>\n      </div>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span class=\"octomap-2d-pgm__param-label\" title=\"\u53EA\u5F71\u54CD\u753B\u51FA\u6765\u7684\u5706\u70B9\u5927\u5C0F\uFF0C\u4E0D\u53C2\u4E0E\u5BFB\u8DEF\u3002\">\u8D77\u70B9\u5927\u5C0F\uFF08\u683C\uFF09</span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"1\"\n          step=\"1\"\n          [value]=\"markerSize()\"\n          (change)=\"on.markerSize($event)\"\n        />\n      </label>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span class=\"octomap-2d-pgm__param-label\" title=\"\u8D77\u70B9\u843D\u5728\u4E0D\u53EF\u8D70\u7684\u683C\u5B50\u4E0A\u65F6\uFF0C\u6700\u591A\u627E\u8FD9\u4E48\u8FDC\u843D\u811A\u3002\">\n          \u8D77\u70B9\u5438\u9644\uFF08m\uFF09\n        </span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"0\"\n          step=\"0.05\"\n          [value]=\"startSnapRadius()\"\n          (change)=\"on.startSnapRadius($event)\"\n        />\n      </label>\n\n      <label class=\"octomap-2d-pgm__param\">\n        <span\n          class=\"octomap-2d-pgm__param-label\"\n          title=\"\u8D77\u70B9\u5468\u56F4\u8981\u6C42\u7684\u6700\u5C0F\u51C0\u7A7A\uFF1B\u4E0D\u8D85\u8FC7\u5168\u5C40\u78B0\u649E\u534A\u5F84\u65F6\u4E0D\u751F\u6548\u3002\"\n        >\n          \u8D77\u70B9\u78B0\u649E\uFF08m\uFF09\n        </span>\n        <input\n          class=\"octomap-2d-pgm__number\"\n          type=\"number\"\n          min=\"0\"\n          step=\"0.05\"\n          [value]=\"startClearance()\"\n          (change)=\"on.startClearance($event)\"\n        />\n      </label>\n\n      <button\n        class=\"octomap-2d-pgm__button octomap-2d-pgm__button--go\"\n        type=\"button\"\n        [disabled]=\"!canSearch()\"\n        (click)=\"runSearch()\"\n      >\n        \u5F00\u59CB\u5BFB\u5740\n      </button>\n\n      <p class=\"octomap-2d-pgm__status\">{{ statusText() }}</p>\n\n      <button class=\"octomap-2d-pgm__button octomap-2d-pgm__button--ghost\" type=\"button\" (click)=\"clearMarks()\">\n        \u6E05\u9664\u8D77\u7EC8\u70B9\n      </button>\n    </aside>\n\n    <div class=\"octomap-2d-pgm__viewport\">\n      <canvas\n        #canvas\n        class=\"octomap-2d-pgm__canvas\"\n        [class.octomap-2d-pgm__canvas--empty]=\"!grid()\"\n        (pointerdown)=\"onPointerDown($event)\"\n        (contextmenu)=\"onContextMenu($event)\"\n      ></canvas>\n      @if (!grid()) {\n        <p class=\"octomap-2d-pgm__empty\">\u8FD8\u6CA1\u6709\u53EF\u7528\u7684 PGM \u5730\u56FE\u3002\u5148\u5728\u5DE5\u5177\u6761\u4E0A\u52A0\u8F7D\u4E00\u4E2A .pgm \u6587\u4EF6\u3002</p>\n      }\n    </div>\n  </div>\n\n  <div class=\"octomap-2d-pgm__legend\">\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--free\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u53EF\u8D70</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--obstacle\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u969C\u788D</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--inflated\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u78B0\u649E\u81A8\u80C0</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--path\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8DEF\u5F84</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--stuck\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8D70\u4E0D\u901A\uFF08\u6B8B\u6BB5 / \u5361\u70B9\uFF09</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--start\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u8D77\u70B9\uFF08\u542B\u8DB3\u8FF9\uFF09</span>\n    <span class=\"octomap-2d-pgm__swatch octomap-2d-pgm__swatch--goal\"></span>\n    <span class=\"octomap-2d-pgm__legend-text\">\u7EC8\u70B9</span>\n\n    <span class=\"octomap-2d-pgm__hint\">\u5DE6\u952E\u8BBE\u8D77\u70B9\uFF0C\u53F3\u952E\u8BBE\u7EC8\u70B9\uFF0C\u7136\u540E\u70B9\u300C\u5F00\u59CB\u5BFB\u5740\u300D\u3002{{ modeHint() }}</span>\n  </div>\n</section>\n", styles: [":host{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color:#e6edf7;background:#0b1016;color-scheme:dark}.octomap-2d-pgm{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}.octomap-2d-pgm__bar{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:10px 16px;background:#141a24;border-bottom:1px solid #232b3a}.octomap-2d-pgm__field{display:flex;align-items:center;gap:8px}.octomap-2d-pgm__label{font-size:13px;color:#8b98ad}.octomap-2d-pgm__control{padding:6px 10px;font-size:13px;color:#e6edf7;background:#1d2635;border:1px solid #2a3448;border-radius:6px}.octomap-2d-pgm__readout{font-size:13px;color:#8b98ad;white-space:nowrap}.octomap-2d-pgm__info{margin-left:auto;font-size:12px;color:#6b7a91;white-space:nowrap}.octomap-2d-pgm__button{padding:7px 14px;font-size:13px;color:#e6edf7;background:#2b6cb0;border:none;border-radius:6px;cursor:pointer}.octomap-2d-pgm__button:hover:not(:disabled){background:#3380d0}.octomap-2d-pgm__button:disabled{color:#6b7a91;background:#263243;cursor:not-allowed}.octomap-2d-pgm__button--go{margin-top:4px;font-weight:600}.octomap-2d-pgm__button--ghost{background:transparent;color:#8b98ad;border:1px solid #2a3448}.octomap-2d-pgm__button--ghost:hover:not(:disabled){background:#1d2635;color:#e6edf7}.octomap-2d-pgm__main{display:flex;flex:1 1 auto;min-height:0}.octomap-2d-pgm__panel{flex:0 0 236px;display:flex;flex-direction:column;gap:10px;padding:14px;overflow-y:auto;background:#10161f;border-right:1px solid #232b3a}.octomap-2d-pgm__panel-title{margin:0;font-size:13px;font-weight:600;letter-spacing:.04em;color:#8b98ad}.octomap-2d-pgm__coords{display:flex;flex-direction:column;gap:6px;padding:10px;background:#141a24;border:1px solid #232b3a;border-radius:8px}.octomap-2d-pgm__coord{display:flex;justify-content:space-between;gap:8px;font-size:12px}.octomap-2d-pgm__coord-label{display:flex;align-items:center;gap:6px;color:#8b98ad}.octomap-2d-pgm__coord-value{color:#e6edf7;font-variant-numeric:tabular-nums}.octomap-2d-pgm__dot{width:8px;height:8px;border-radius:50%}.octomap-2d-pgm__dot--start{background:#16a34a}.octomap-2d-pgm__dot--goal{background:#f59e0b}.octomap-2d-pgm__param{display:flex;flex-direction:column;gap:4px}.octomap-2d-pgm__param-label{font-size:12px;color:#8b98ad}.octomap-2d-pgm__number{width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;color:#e6edf7;background:#1d2635;border:1px solid #2a3448;border-radius:6px}.octomap-2d-pgm__status{margin:0;font-size:12px;line-height:1.5;color:#aab6c8;word-break:break-word}.octomap-2d-pgm__viewport{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0b1016}.octomap-2d-pgm__canvas{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;cursor:crosshair}.octomap-2d-pgm__canvas--empty{display:none}.octomap-2d-pgm__empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;padding:24px;font-size:14px;color:#8b98ad;text-align:center}.octomap-2d-pgm__legend{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 16px 12px;background:#141a24}.octomap-2d-pgm__swatch{width:12px;height:12px;border-radius:3px;border:1px solid rgba(255,255,255,.18)}.octomap-2d-pgm__swatch--free{background:#f8fafc}.octomap-2d-pgm__swatch--obstacle{background:#1f2937}.octomap-2d-pgm__swatch--inflated{background:#fecaca}.octomap-2d-pgm__swatch--path{background:#2563eb}.octomap-2d-pgm__swatch--stuck{background:#dc2626}.octomap-2d-pgm__swatch--start{background:#16a34a}.octomap-2d-pgm__swatch--goal{background:#f59e0b}.octomap-2d-pgm__legend-text{font-size:12px;color:#8b98ad}.octomap-2d-pgm__hint{flex:1 1 100%;font-size:12px;color:#6b7a91}\n"] }]
        }], ctorParameters: () => [], propDecorators: { image: [{
                type: Input
            }], resolution: [{
                type: Input
            }], dogRadius: [{
                type: Input
            }], goalRadius: [{
                type: Input
            }], mode: [{
                type: Input
            }], modeChange: [{
                type: Output
            }], pathChange: [{
                type: Output
            }], canvasRef: [{ type: i0.ViewChild, args: ['canvas', { isSignal: true }] }] } });
/** 「起点大小」的自动值：短边的 1/120，与原来固定圆点的观感一致。 */
function autoMarkerSize(grid) {
    return Math.max(1, Math.round(Math.min(grid.width, grid.height) / 120));
}
/** 从输入框里读一个有限的非负数；非法时回填 `fallback`，并且不改信号。 */
function readNumber(event, fallback, min) {
    const input = event.target;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < min) {
        input.value = String(fallback);
        return fallback;
    }
    return value;
}
/** 格索引序列 → 画布上的格心坐标（1 格 = 1 像素）。 */
function cellPoints(grid, cells) {
    return cells.map((cell) => cellCenter(grid, cell));
}
function cellCenter(grid, cell) {
    return {
        x: (cell % grid.width) + 0.5,
        y: ((cell / grid.width) | 0) + 0.5,
    };
}
/** 把一串格心连成路径，不额外提交 stroke——调用方决定描边宽度与颜色。 */
function tracePath(context, points) {
    context.beginPath();
    for (let i = 0; i < points.length; i++) {
        if (i === 0) {
            context.moveTo(points[i].x, points[i].y);
        }
        else {
            context.lineTo(points[i].x, points[i].y);
        }
    }
}
/**
 * 端点标记。`footprintRadius` > 0 时额外画一圈碰撞足迹：起点那一圈就是小狗在二维
 * 图上占的地方，用户调「起点碰撞」时它跟着变。`dotRadius` 是圆点本身的大小（格）。
 */
function drawMarker(context, grid, cell, color, footprintRadius, dotRadius) {
    const { x, y } = cellCenter(grid, cell);
    const footprintCells = footprintRadius > 0 ? footprintRadius / grid.resolution : 0;
    const lineWidth = Math.max(0.8, Math.min(grid.width, grid.height) / 400);
    if (footprintCells > 0) {
        context.beginPath();
        context.arc(x, y, footprintCells, 0, Math.PI * 2);
        context.fillStyle = 'rgba(22, 163, 74, 0.18)';
        context.fill();
    }
    context.beginPath();
    const radius = Math.max(1.5, dotRadius ?? Math.min(grid.width, grid.height) / 120);
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = '#ffffff';
    context.lineWidth = lineWidth;
    context.stroke();
    // 足迹圈放在圆点之后描边：圆点比足迹大时（大图、起点大小调大）那一圈也还看得见。
    if (footprintCells > 0) {
        context.beginPath();
        context.arc(x, y, footprintCells, 0, Math.PI * 2);
        context.strokeStyle = 'rgba(22, 163, 74, 0.9)';
        context.lineWidth = lineWidth;
        context.stroke();
    }
}
/** 走不通时，在卡住的格上画一个红叉（白色描边垫底）。 */
function drawStuckCross(context, grid, cell) {
    const { x, y } = cellCenter(grid, cell);
    const radius = Math.max(3, Math.min(grid.width, grid.height) / 90);
    const stroke = () => {
        context.beginPath();
        context.moveTo(x - radius, y - radius);
        context.lineTo(x + radius, y + radius);
        context.moveTo(x + radius, y - radius);
        context.lineTo(x - radius, y + radius);
        context.stroke();
    };
    context.save();
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.lineWidth = Math.max(2.4, Math.min(grid.width, grid.height) / 100);
    stroke();
    context.strokeStyle = '#dc2626';
    context.lineWidth = Math.max(1.2, Math.min(grid.width, grid.height) / 220);
    stroke();
    context.restore();
}

/*
 * howell-octomap-2d 的公开入口。
 *
 * 组件、网格类型、建图/寻路函数与 PGM 编解码都公开：宿主既可以直接使用组件，
 * 也可以自己建网格做离屏计算。
 */

/**
 * Generated bundle index. Do not edit.
 */

export { OCTO_MAP_PGM_DEFAULT_DOG_RADIUS, OCTO_MAP_PGM_DEFAULT_GOAL_RADIUS, OCTO_MAP_PGM_DEFAULT_RESOLUTION, OCTO_MAP_PGM_MODE_LABELS, Octomap2dPgmComponent, PGM_DARK_MAX, PGM_FREE, PGM_FREE_MIN, PGM_OCCUPIED, buildPgmGrid, decodePgm, encodePgm, findPgmPath, inflateBlocked, pgmCellToWorld, pgmWorldToCell, planPgmPath, searchPgmPath, smoothPgmPath, snapToFree };
//# sourceMappingURL=howell-octomap-2d.mjs.map
