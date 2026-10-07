<script setup lang="ts">
import { computed, ref } from "vue";
import { useShiftStore } from "../store/shiftStore";
import { describeOp } from "../store/sync";
import type { PayMethod } from "../domain/types";
import { PAY_METHODS } from "../domain/types";

const store = useShiftStore();

const fmtTime = (t: number) => new Date(t).toLocaleString("zh-CN", { hour12: false });

// ---------- 模拟对端改动 ----------
const simHandoverId = ref("");
const simSales = ref<number | null>(null);
const simNote = ref("");
const simPayMethod = ref<PayMethod>("电子支付");
const simPayAmount = ref<number | null>(null);

const simOptions = computed(() =>
  store.activeHandovers.map((h) => ({ id: h.id, label: `${h.shiftDate} ${h.shift} · ${h.operator}` }))
);

function doCloudEdit() {
  if (!simHandoverId.value) return;
  const patch: { salesAmount?: number; notes?: string } = {};
  if (simSales.value && simSales.value > 0) patch.salesAmount = simSales.value;
  if (simNote.value.trim()) patch.notes = simNote.value.trim();
  if (!patch.salesAmount && !patch.notes) return;
  store.simulateCloudEdit(simHandoverId.value, patch);
  simSales.value = null;
  simNote.value = "";
}

function doCloudPayment() {
  if (!simHandoverId.value || !(simPayAmount.value && simPayAmount.value > 0)) return;
  store.simulateCloudPayment(simHandoverId.value, simPayMethod.value, simPayAmount.value);
  simPayAmount.value = null;
}

const opLabel = describeOp;
</script>

<template>
  <section>
    <div class="panel">
      <h3>网络与同步</h3>
      <div class="sync-bar">
        <span class="status" :class="store.online ? 'st-reviewed' : 'st-diff'">
          {{ store.online ? "在线" : "离线（录入照常，操作入待传队列）" }}
        </span>
        <button type="button" class="secondary" @click="store.setOnline(!store.online)">
          {{ store.online ? "模拟断网" : "恢复网络" }}
        </button>
        <label class="check">
          <input type="checkbox" v-model="store.flaky" />
          模拟上传丢确认（验证重放幂等）
        </label>
        <button type="button" :disabled="!store.online || store.syncing" @click="store.syncNow()">
          {{ store.syncing ? "同步中…" : `立即同步（待传 ${store.pendingOps}）` }}
        </button>
        <span v-if="store.lastSyncAt" class="hint">上次同步：{{ fmtTime(store.lastSyncAt) }}</span>
      </div>
    </div>

    <div class="panel" v-if="store.db.conflicts.length > 0">
      <h3>冲突待站长核对（{{ store.db.conflicts.length }}）</h3>
      <p class="hint">同一班次两端各有改动：站内已复核值不会被迟到副本覆盖，两版都保留，请核对后拍板。</p>
      <article v-for="c in store.db.conflicts" :key="c.handoverId" class="conflict">
        <div class="conflict-grid">
          <div class="conflict-side">
            <h4>站内版（当前值 · {{ c.stationVersion.status }}）</h4>
            <p>销售额：¥{{ c.stationVersion.salesAmount.toFixed(2) }}</p>
            <p>备注：{{ c.stationVersion.notes }}</p>
            <p>更新：{{ fmtTime(c.stationVersion.updatedAt) }} · rev {{ c.stationVersion.rev }}</p>
            <button type="button" @click="store.resolveConflict(c.handoverId, 'station')">保留站内版</button>
          </div>
          <div class="conflict-side incoming">
            <h4>迟到副本（对端 · {{ c.incomingVersion.status }}）</h4>
            <p>销售额：¥{{ c.incomingVersion.salesAmount.toFixed(2) }}</p>
            <p>备注：{{ c.incomingVersion.notes }}</p>
            <p>更新：{{ fmtTime(c.incomingVersion.updatedAt) }} · rev {{ c.incomingVersion.rev }}</p>
            <button type="button" class="secondary" @click="store.resolveConflict(c.handoverId, 'incoming')">采用迟到副本</button>
          </div>
        </div>
      </article>
    </div>

    <div class="panel">
      <h3>待传队列（{{ store.db.outbox.length }}）</h3>
      <table class="grid-table full">
        <thead><tr><th>操作</th><th>重试次数</th><th>最近错误</th><th>入队时间</th></tr></thead>
        <tbody>
          <tr v-for="op in store.db.outbox" :key="op.opId">
            <td>{{ opLabel(op) }}</td>
            <td>{{ op.attempts }}</td>
            <td class="neg">{{ op.lastError ?? "—" }}</td>
            <td>{{ fmtTime(op.enqueuedAt) }}</td>
          </tr>
          <tr v-if="store.db.outbox.length === 0"><td colspan="4" class="empty">队列已清空</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>模拟对端改动（演示合并与冲突）</h3>
      <div class="form-row">
        <label>班次
          <select v-model="simHandoverId">
            <option value="" disabled>请选择班次</option>
            <option v-for="o in simOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </label>
        <label>云端改销售额<input v-model.number="simSales" type="number" min="0" step="0.01" placeholder="留空则不改" /></label>
        <label>云端改备注<input v-model="simNote" placeholder="留空则不改" /></label>
        <button type="button" class="secondary" @click="doCloudEdit">云端直改</button>
      </div>
      <div class="form-row">
        <label>云端补登收款
          <select v-model="simPayMethod"><option v-for="m in PAY_METHODS" :key="m">{{ m }}</option></select>
        </label>
        <label>金额<input v-model.number="simPayAmount" type="number" min="0.01" step="0.01" placeholder="0.00" /></label>
        <button type="button" class="secondary" @click="doCloudPayment">云端入账</button>
      </div>
      <p class="hint">对端改动后点“立即同步”：两端都改过的班次会进冲突区；仅对端改动的直接合并进站内账本。</p>
    </div>

    <div class="panel">
      <h3>同步日志</h3>
      <ul class="log">
        <li v-for="(entry, i) in store.db.log" :key="i">
          <span>{{ fmtTime(entry.at) }}</span>{{ entry.message }}
        </li>
      </ul>
    </div>
  </section>
</template>
