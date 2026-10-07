<script setup lang="ts">
import { computed, ref } from "vue";
import { useShiftStore } from "../store/shiftStore";
import type { PayMethod } from "../domain/types";
import { PAY_METHODS } from "../domain/types";

const store = useShiftStore();

const handoverId = ref("");
const method = ref<PayMethod>("现金");
const amount = ref<number | null>(null);

const handoverOptions = computed(() =>
  store.activeHandovers.map((h) => ({ id: h.id, label: `${h.shiftDate} ${h.shift} · ${h.operator}` }))
);

/** 待传队列中的收款 id 集合，用于标注“待上传” */
const pendingPaymentIds = computed(() => {
  const ids = new Set<string>();
  for (const op of store.db.outbox) {
    if (op.payload.kind === "add-payment") ids.add(op.payload.payment.id);
  }
  return ids;
});

const sorted = computed(() =>
  [...store.db.payments].sort((a, b) => b.createdAt - a.createdAt)
);

function handoverLabel(id: string): string {
  const h = store.db.handovers.find((x) => x.id === id);
  return h ? `${h.shiftDate} ${h.shift}` : "（已删除班次）";
}

function submit() {
  if (!handoverId.value || !(amount.value && amount.value > 0)) return;
  store.addPayment(handoverId.value, method.value, amount.value);
  amount.value = null;
}
</script>

<template>
  <section>
    <form class="panel form-panel" @submit.prevent="submit">
      <h3>补录收款流水（断网也可入账，恢复后随队列上传）</h3>
      <div class="form-row">
        <label>班次
          <select v-model="handoverId" required>
            <option value="" disabled>请选择班次</option>
            <option v-for="o in handoverOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </label>
        <label>收款方式
          <select v-model="method"><option v-for="m in PAY_METHODS" :key="m">{{ m }}</option></select>
        </label>
        <label>金额（元）
          <input v-model.number="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" />
        </label>
        <button type="submit">入账</button>
      </div>
      <p class="hint">每笔收款自带幂等键：上传失败重试、断网重放，都不会在云端重复入账。</p>
    </form>

    <table class="grid-table full">
      <thead>
        <tr><th>时间</th><th>班次</th><th>方式</th><th>金额（元）</th><th>来源</th><th>同步状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="p in sorted" :key="p.id">
          <td>{{ new Date(p.createdAt).toLocaleString("zh-CN", { hour12: false }) }}</td>
          <td>{{ handoverLabel(p.handoverId) }}</td>
          <td>{{ p.method }}</td>
          <td>{{ p.amount.toFixed(2) }}</td>
          <td>{{ p.origin === "station" ? "站内" : "对端" }}</td>
          <td>
            <span v-if="pendingPaymentIds.has(p.id)" class="status st-pending">待上传</span>
            <span v-else class="status st-reviewed">已同步</span>
          </td>
        </tr>
        <tr v-if="sorted.length === 0"><td colspan="6" class="empty">暂无收款流水</td></tr>
      </tbody>
    </table>
  </section>
</template>
