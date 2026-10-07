<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  FUEL_TYPES,
  PAY_METHODS,
  PUMPS,
  SHIFTS,
  computeSales,
  formatMoney,
  nowIso,
  priceAt,
  readingVolume,
} from "../lib/recon";
import { useReconStore } from "../store";

const store = useReconStore();

const tabs = ["交接单", "油枪读数", "收款流水", "油价"] as const;
const activeTab = ref<(typeof tabs)[number]>("交接单");

const today = new Date().toISOString().slice(0, 10);

// 交接单
const handoverForm = reactive({ shiftDate: today, shift: SHIFTS[0] as string, notes: "" });
function submitHandover() {
  store.addHandover({ ...handoverForm });
  handoverForm.notes = "";
}

// 可补录读数的班次：未复核且无冲突
const editableHandovers = computed(() =>
  store.rows.filter((r) => r.baseStatus === "待复核" && !r.conflictPending)
);
// 可收款的班次：无冲突即可（流水可迟到）
const payableHandovers = computed(() => store.rows.filter((r) => !r.conflictPending));

// 油枪读数
const readingForm = reactive({ handoverId: "", pumpNo: PUMPS[0] as string, fuelType: FUEL_TYPES[0] as string, start: 0, end: 0 });
const readingPreview = computed(() => {
  const vol = readingVolume({ id: "", pumpNo: "", fuelType: "", start: readingForm.start, end: readingForm.end });
  const price = priceAt(store.local.prices, readingForm.fuelType, nowIso());
  return { vol, price, amount: Math.round(vol * price * 100) / 100 };
});
function submitReading() {
  if (!readingForm.handoverId) return;
  store.addReading(readingForm.handoverId, {
    pumpNo: readingForm.pumpNo,
    fuelType: readingForm.fuelType,
    start: Number(readingForm.start),
    end: Number(readingForm.end),
  });
  readingForm.start = readingForm.end;
  readingForm.end = 0;
}

// 收款流水
const paymentForm = reactive({ handoverId: "", method: PAY_METHODS[0] as string, amount: 0 });
function submitPayment() {
  if (!paymentForm.handoverId || paymentForm.amount <= 0) return;
  store.addPayment(paymentForm.handoverId, paymentForm.method, Number(paymentForm.amount));
  paymentForm.amount = 0;
}

// 油价
const priceForm = reactive({ fuelType: FUEL_TYPES[0] as string, price: 7.85, effectiveAt: new Date().toISOString().slice(0, 16) });
function submitPrice() {
  store.addPrice(priceForm.fuelType, Number(priceForm.price), new Date(priceForm.effectiveAt).toISOString());
}
const currentPrices = computed(() =>
  FUEL_TYPES.map((ft) => ({ fuelType: ft, price: store.currentPrice(ft) }))
);

// 销售额试算（与录入读数同一算法）
const previewSales = computed(() => {
  const h = store.handoverOf(readingForm.handoverId);
  if (!h) return 0;
  return computeSales(h.readings, store.local.prices, nowIso());
});
</script>

<template>
  <section class="panel">
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ tab }}
      </button>
    </div>

    <form v-if="activeTab === '交接单'" class="form-grid" @submit.prevent="submitHandover">
      <label>
        日期
        <input v-model="handoverForm.shiftDate" type="date" required />
      </label>
      <label>
        班次
        <select v-model="handoverForm.shift">
          <option v-for="s in SHIFTS" :key="s">{{ s }}</option>
        </select>
      </label>
      <label>
        备注
        <textarea v-model="handoverForm.notes" placeholder="现场情况、异常说明" />
      </label>
      <button type="submit">登记交接单</button>
      <p class="hint">断网也可登记，先存本地待传队列，联网后自动合并。</p>
    </form>

    <form v-else-if="activeTab === '油枪读数'" class="form-grid" @submit.prevent="submitReading">
      <label>
        交接单（仅未复核可补录）
        <select v-model="readingForm.handoverId" required>
          <option value="">请选择</option>
          <option v-for="r in editableHandovers" :key="r.id" :value="r.id">
            {{ r.shiftDate }} {{ r.shift }}
          </option>
        </select>
      </label>
      <div class="field-row">
        <label>
          油枪
          <select v-model="readingForm.pumpNo">
            <option v-for="p in PUMPS" :key="p">{{ p }}</option>
          </select>
        </label>
        <label>
          油品
          <select v-model="readingForm.fuelType">
            <option v-for="f in FUEL_TYPES" :key="f">{{ f }}</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label>
          起泵读数
          <input v-model.number="readingForm.start" type="number" min="0" step="0.01" required />
        </label>
        <label>
          止泵读数
          <input v-model.number="readingForm.end" type="number" min="0" step="0.01" required />
        </label>
      </div>
      <p class="hint">
        本枪销量 {{ readingPreview.vol.toFixed(2) }} L，按当前油价 ¥{{ readingPreview.price.toFixed(2) }}/L
        预计 ¥{{ formatMoney(readingPreview.amount) }}；该单销售额累计 ¥{{ formatMoney(previewSales) }}
      </p>
      <button type="submit" :disabled="!readingForm.handoverId">补录读数</button>
    </form>

    <form v-else-if="activeTab === '收款流水'" class="form-grid" @submit.prevent="submitPayment">
      <label>
        交接单
        <select v-model="paymentForm.handoverId" required>
          <option value="">请选择</option>
          <option v-for="r in payableHandovers" :key="r.id" :value="r.id">
            {{ r.shiftDate }} {{ r.shift }}（{{ r.displayStatus }}）
          </option>
        </select>
      </label>
      <div class="field-row">
        <label>
          收款方式
          <select v-model="paymentForm.method">
            <option v-for="m in PAY_METHODS" :key="m">{{ m }}</option>
          </select>
        </label>
        <label>
          金额（元）
          <input v-model.number="paymentForm.amount" type="number" min="0.01" step="0.01" required />
        </label>
      </div>
      <button type="submit" :disabled="!paymentForm.handoverId">登记收款</button>
      <p class="hint">每笔收款带幂等键，上传失败重试、重放都不会多出流水。</p>
    </form>

    <form v-else class="form-grid" @submit.prevent="submitPrice">
      <div class="price-now">
        <span v-for="p in currentPrices" :key="p.fuelType" class="tag">
          {{ p.fuelType }} ¥{{ p.price.toFixed(2) }}/L
        </span>
      </div>
      <div class="field-row">
        <label>
          油品
          <select v-model="priceForm.fuelType">
            <option v-for="f in FUEL_TYPES" :key="f">{{ f }}</option>
          </select>
        </label>
        <label>
          新价（元/L）
          <input v-model.number="priceForm.price" type="number" min="0.01" step="0.01" required />
        </label>
      </div>
      <label>
        生效时间
        <input v-model="priceForm.effectiveAt" type="datetime-local" required />
      </label>
      <button type="submit">发布油价</button>
      <p class="hint">发布后未复核交接单立即按新价重算销售额；已复核班次金额锁定不变。</p>
    </form>
  </section>
</template>
