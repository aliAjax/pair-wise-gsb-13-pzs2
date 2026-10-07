<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useShiftStore } from "../store/shiftStore";
import { downloadCsv } from "../domain/exporter";
import { readingVolume } from "../domain/reconcile";
import type { FuelType, NozzleReading, ReconStatus, ShiftName } from "../domain/types";
import { SHIFT_NAMES } from "../domain/types";

const store = useShiftStore();

const NOZZLES: { id: string; fuelType: FuelType }[] = [
  { id: "1号枪", fuelType: "92#汽油" },
  { id: "2号枪", fuelType: "95#汽油" },
  { id: "3号枪", fuelType: "0#柴油" },
  { id: "4号枪", fuelType: "92#汽油" }
];

const STATUS_FILTERS = ["全部", "待复核", "已复核", "有差异", "有冲突"] as const;
const filter = ref<(typeof STATUS_FILTERS)[number]>("全部");
const rows = computed(() =>
  filter.value === "全部" ? store.reconRows : store.reconRows.filter((r) => r.status === filter.value)
);

const statusClass: Record<ReconStatus, string> = {
  待复核: "st-pending",
  已复核: "st-reviewed",
  有差异: "st-diff",
  有冲突: "st-conflict"
};

// ---------- 新建交接单 ----------
const showForm = ref(false);
const form = reactive({
  shiftDate: new Date().toISOString().slice(0, 10),
  shift: "早班" as ShiftName,
  operator: "",
  notes: ""
});
const formReadings = ref<NozzleReading[]>([
  { nozzleId: "1号枪", fuelType: "92#汽油", opening: 0, closing: 0 }
]);

function addReadingRow() {
  const used = new Set(formReadings.value.map((r) => r.nozzleId));
  const free = NOZZLES.find((n) => !used.has(n.id)) ?? NOZZLES[0];
  formReadings.value.push({ nozzleId: free.id, fuelType: free.fuelType, opening: 0, closing: 0 });
}

function onNozzleChange(row: NozzleReading) {
  const nz = NOZZLES.find((n) => n.id === row.nozzleId);
  if (nz) row.fuelType = nz.fuelType;
}

function submitHandover() {
  const readings = formReadings.value.filter((r) => r.closing > r.opening);
  if (readings.length === 0) {
    alert("请至少填写一条有效油枪读数（收班表数需大于开班表数）");
    return;
  }
  store.addHandover({
    shiftDate: form.shiftDate,
    shift: form.shift,
    operator: form.operator.trim(),
    readings: readings.map((r) => ({ ...r })),
    notes: form.notes.trim()
  });
  showForm.value = false;
  form.operator = "";
  form.notes = "";
  formReadings.value = [{ nozzleId: "1号枪", fuelType: "92#汽油", opening: 0, closing: 0 }];
}

// ---------- 补录读数 ----------
const editingId = ref<string | null>(null);
const editReadings = ref<NozzleReading[]>([]);

function startEdit(handoverId: string) {
  const h = store.db.handovers.find((x) => x.id === handoverId);
  if (!h) return;
  editingId.value = handoverId;
  editReadings.value = h.readings.map((r) => ({ ...r }));
}

function saveEdit() {
  if (!editingId.value) return;
  store.updateReadings(editingId.value, editReadings.value.map((r) => ({ ...r })));
  editingId.value = null;
}

// ---------- 导出 ----------
function doExport() {
  downloadCsv(`交接对账-${new Date().toISOString().slice(0, 10)}.csv`, store.exportCsv());
}

const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <section>
    <div class="metrics">
      <article class="metric"><span>交接单</span><strong>{{ store.summary.total }}</strong></article>
      <article class="metric"><span>待复核 / 有差异 / 有冲突</span><strong>{{ store.summary.pending }} / {{ store.summary.diff }} / {{ store.summary.conflict }}</strong></article>
      <article class="metric"><span>总销售额（元）</span><strong>{{ fmt(store.summary.salesSum) }}</strong></article>
      <article class="metric"><span>总收款收入（元）</span><strong>{{ fmt(store.summary.receivedSum) }}</strong></article>
      <article class="metric"><span>总差额（元）</span><strong :class="{ neg: store.summary.diffSum !== 0 }">{{ fmt(store.summary.diffSum) }}</strong></article>
    </div>

    <div class="toolbar">
      <div class="toolbar-left">
        <select v-model="filter">
          <option v-for="f in STATUS_FILTERS" :key="f">{{ f }}</option>
        </select>
        <button type="button" class="secondary" @click="showForm = !showForm">
          {{ showForm ? "收起" : "新增交接单" }}
        </button>
      </div>
      <button type="button" @click="doExport">导出对账 CSV</button>
    </div>

    <form v-if="showForm" class="panel form-panel" @submit.prevent="submitHandover">
      <h3>新增交接单（离线可填，恢复后自动入待传队列）</h3>
      <div class="form-row">
        <label>日期<input v-model="form.shiftDate" type="date" required /></label>
        <label>班次
          <select v-model="form.shift"><option v-for="s in SHIFT_NAMES" :key="s">{{ s }}</option></select>
        </label>
        <label>交班人<input v-model="form.operator" placeholder="姓名" /></label>
      </div>
      <table class="grid-table">
        <thead><tr><th>油枪</th><th>油品</th><th>开班表数</th><th>收班表数</th><th>销量(L)</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in formReadings" :key="i">
            <td>
              <select v-model="row.nozzleId" @change="onNozzleChange(row)">
                <option v-for="n in NOZZLES" :key="n.id" :value="n.id">{{ n.id }}</option>
              </select>
            </td>
            <td>{{ row.fuelType }}</td>
            <td><input v-model.number="row.opening" type="number" min="0" step="0.01" required /></td>
            <td><input v-model.number="row.closing" type="number" min="0" step="0.01" required /></td>
            <td>{{ readingVolume(row) }}</td>
            <td><button type="button" class="danger small" @click="formReadings.splice(i, 1)">删</button></td>
          </tr>
        </tbody>
      </table>
      <div class="form-row">
        <button type="button" class="secondary" @click="addReadingRow">+ 加一条油枪</button>
        <input v-model="form.notes" placeholder="备注（可选）" />
        <button type="submit">保存交接单</button>
      </div>
    </form>

    <div class="record-grid">
      <div v-if="rows.length === 0" class="empty">暂无匹配数据</div>
      <article v-for="row in rows" :key="row.handover.id" class="record">
        <div class="record-head">
          <p class="record-title">
            {{ row.handover.shiftDate }} {{ row.handover.shift }} · {{ row.handover.operator }}
            <span v-if="row.handover.origin === 'cloud'" class="tag-mini">来自对端</span>
          </p>
          <span class="status" :class="statusClass[row.status]">{{ row.status }}</span>
        </div>

        <table class="grid-table">
          <thead><tr><th>油枪</th><th>油品</th><th>开班</th><th>收班</th><th>销量(L)</th><th>单价</th></tr></thead>
          <tbody>
            <tr v-for="r in row.handover.readings" :key="r.nozzleId">
              <td>{{ r.nozzleId }}</td>
              <td>{{ r.fuelType }}</td>
              <td>{{ r.opening }}</td>
              <td>{{ r.closing }}</td>
              <td>{{ readingVolume(r) }}</td>
              <td>¥{{ (row.handover.priceSnapshot[r.fuelType] ?? 0).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="amounts">
          <span>销售额 <strong>¥{{ fmt(row.salesAmount) }}</strong></span>
          <span>收款合计 <strong>¥{{ fmt(row.received) }}</strong></span>
          <span :class="{ neg: row.diff !== 0 }">差额 <strong>¥{{ fmt(row.diff) }}</strong></span>
        </div>
        <p class="note">{{ row.handover.notes }}</p>

        <div v-if="editingId === row.handover.id" class="edit-box">
          <table class="grid-table">
            <thead><tr><th>油枪</th><th>开班表数</th><th>收班表数</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in editReadings" :key="i">
                <td>{{ r.nozzleId }}（{{ r.fuelType }}）</td>
                <td><input v-model.number="r.opening" type="number" min="0" step="0.01" /></td>
                <td><input v-model.number="r.closing" type="number" min="0" step="0.01" /></td>
              </tr>
            </tbody>
          </table>
          <div class="actions">
            <button type="button" @click="saveEdit">保存读数并重算</button>
            <button type="button" class="secondary" @click="editingId = null">取消</button>
          </div>
        </div>

        <div class="actions">
          <button v-if="row.handover.status !== '已复核'" type="button" @click="store.review(row.handover.id)">复核通过</button>
          <button v-if="row.handover.status !== '已复核'" type="button" class="secondary" @click="startEdit(row.handover.id)">补录读数</button>
          <button type="button" class="danger" @click="store.removeHandover(row.handover.id)">删除</button>
        </div>
      </article>
    </div>
  </section>
</template>
