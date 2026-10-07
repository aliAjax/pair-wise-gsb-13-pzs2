import type { CloudDb, Handover, Payment, PriceRecord, StationDb } from "../domain/types";
import { computeSales } from "../domain/reconcile";
import { currentPrices } from "../domain/pricing";

const STATION_KEY = "dfwlfront-7-station";
const CLOUD_KEY = "dfwlfront-7-cloud";

export function loadStation(): StationDb {
  const raw = localStorage.getItem(STATION_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as StationDb;
    } catch {
      /* 落回种子数据 */
    }
  }
  const db = seedStation();
  saveStation(db);
  return db;
}

export function saveStation(db: StationDb): void {
  localStorage.setItem(STATION_KEY, JSON.stringify(db));
}

export function loadCloud(): CloudDb {
  const raw = localStorage.getItem(CLOUD_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as CloudDb;
    } catch {
      /* 落回种子数据 */
    }
  }
  const db = seedCloud();
  saveCloud(db);
  return db;
}

export function saveCloud(db: CloudDb): void {
  localStorage.setItem(CLOUD_KEY, JSON.stringify(db));
}

const DAY = 86400000;
const T0 = new Date("2026-10-06T06:00:00").getTime();

function seedPrices(): PriceRecord[] {
  return [
    { fuelType: "92#汽油", price: 7.85, effectiveAt: T0 - 5 * DAY },
    { fuelType: "95#汽油", price: 8.32, effectiveAt: T0 - 5 * DAY },
    { fuelType: "0#柴油", price: 7.12, effectiveAt: T0 - 5 * DAY }
  ];
}

function seedHandovers(prices: PriceRecord[]): Handover[] {
  const priceMap = currentPrices(prices, T0);
  type Seed = Pick<Handover, "id" | "shiftDate" | "shift" | "operator" | "readings" | "status" | "notes" | "updatedAt">;
  const base: Seed[] = [
    {
      id: "ho-seed-a",
      shiftDate: "2026-10-05",
      shift: "早班",
      operator: "王芳",
      readings: [
        { nozzleId: "1号枪", fuelType: "92#汽油", opening: 10234, closing: 10892 },
        { nozzleId: "3号枪", fuelType: "0#柴油", opening: 8831, closing: 9210 }
      ],
      status: "已复核",
      notes: "账实一致",
      updatedAt: T0 - DAY
    },
    {
      id: "ho-seed-b",
      shiftDate: "2026-10-05",
      shift: "中班",
      operator: "李强",
      readings: [
        { nozzleId: "2号枪", fuelType: "95#汽油", opening: 5641, closing: 6020 },
        { nozzleId: "1号枪", fuelType: "92#汽油", opening: 10892, closing: 11350 }
      ],
      status: "待复核",
      notes: "等待站长确认",
      updatedAt: T0 - DAY + 8 * 3600000
    },
    {
      id: "ho-seed-c",
      shiftDate: "2026-10-06",
      shift: "早班",
      operator: "赵敏",
      readings: [{ nozzleId: "3号枪", fuelType: "0#柴油", opening: 9210, closing: 9650 }],
      status: "待复核",
      notes: "收款尚未补齐",
      updatedAt: T0
    }
  ];
  return base.map((h) => ({
    ...h,
    salesAmount: computeSales(h, priceMap),
    priceSnapshot: { ...priceMap },
    rev: 1,
    syncedRev: 1,
    origin: "station",
    deleted: false
  }));
}

function seedPayments(): Payment[] {
  return [
    { id: "pay-seed-a1", handoverId: "ho-seed-a", method: "现金", amount: 2863.78, createdAt: T0 - DAY, origin: "station" },
    { id: "pay-seed-a2", handoverId: "ho-seed-a", method: "电子支付", amount: 5000, createdAt: T0 - DAY, origin: "station" },
    { id: "pay-seed-b1", handoverId: "ho-seed-b", method: "电子支付", amount: 6748.58, createdAt: T0 - DAY + 8 * 3600000, origin: "station" },
    { id: "pay-seed-c1", handoverId: "ho-seed-c", method: "现金", amount: 3000, createdAt: T0, origin: "station" }
  ];
}

function seedStation(): StationDb {
  const prices = seedPrices();
  return {
    handovers: seedHandovers(prices),
    payments: seedPayments(),
    prices,
    conflicts: [],
    outbox: [],
    log: [{ at: T0, message: "初始化：站内账本就绪（种子数据已与云端对齐）" }]
  };
}

/** 云端初始为同一份已对齐账本，模拟此前已同步过 */
function seedCloud(): CloudDb {
  const station = seedStation();
  return {
    handovers: station.handovers,
    payments: station.payments,
    prices: station.prices,
    appliedOpIds: []
  };
}
