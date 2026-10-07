<script setup lang="ts">
import { computed } from "vue";
import EntryPanel from "./components/EntryPanel.vue";
import HandoverList from "./components/HandoverList.vue";
import SyncPanel from "./components/SyncPanel.vue";
import { BASE_STATUSES, CONFLICT_STATUS, formatMoney, formatTime } from "./lib/recon";
import { useReconStore } from "./store";

const store = useReconStore();

const metrics = computed(() => [
  { label: "交接单", value: String(store.summary.total) },
  { label: "已复核", value: String(store.summary.byStatus["已复核"] ?? 0) },
  { label: "冲突待核", value: String(store.summary.byStatus[CONFLICT_STATUS] ?? 0) },
  { label: "销售额（元）", value: formatMoney(store.summary.sales) },
  { label: "实收（元）", value: formatMoney(store.summary.received) },
]);

const statusOrder = computed(() => [...BASE_STATUSES, CONFLICT_STATUS]);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 离线可续作</p>
          <h1>加油站班次交接对账</h1>
          <p class="subtitle">
            交接单、油枪读数、收款流水分开补录，断网照常录入；网络恢复后自动合并双端记录，
            冲突留两版待站长核对，重放不多账。
          </p>
        </div>
        <div class="net-state" :class="{ offline: !store.online }">
          <span class="dot" />
          {{ store.online ? "在线" : "离线（本地续作）" }}
          <small v-if="store.pendingCount > 0">待传 {{ store.pendingCount }}</small>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="side">
          <EntryPanel />
          <SyncPanel />
        </div>

        <div class="main-col">
          <HandoverList />

          <section class="list-panel">
            <div class="toolbar">
              <h2>班次汇总</h2>
              <button type="button" @click="store.exportCsv()">导出 CSV</button>
            </div>
            <div class="summary-grid">
              <div v-for="s in statusOrder" :key="s" class="summary-cell">
                <span>{{ s }}</span>
                <strong>{{ store.summary.byStatus[s] ?? 0 }}</strong>
              </div>
              <div class="summary-cell">
                <span>销售额合计</span>
                <strong>¥{{ formatMoney(store.summary.sales) }}</strong>
              </div>
              <div class="summary-cell">
                <span>实收合计</span>
                <strong>¥{{ formatMoney(store.summary.received) }}</strong>
              </div>
              <div class="summary-cell" :class="{ 'diff-bad': Math.abs(store.summary.diff) >= 0.005 }">
                <span>差异合计</span>
                <strong>¥{{ formatMoney(store.summary.diff) }}</strong>
              </div>
            </div>
            <p class="hint">
              列表、本汇总与导出 CSV 取自同一对账视图，状态与收入完全一致。
              最近同步：{{ formatTime(store.local.lastSyncAt) }}
            </p>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
