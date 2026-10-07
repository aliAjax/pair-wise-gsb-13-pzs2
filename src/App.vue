<script setup lang="ts">
import { ref } from "vue";
import { useShiftStore } from "./store/shiftStore";
import HandoverBoard from "./components/HandoverBoard.vue";
import PaymentPanel from "./components/PaymentPanel.vue";
import PricePanel from "./components/PricePanel.vue";
import SyncPanel from "./components/SyncPanel.vue";

const store = useShiftStore();

const tabs = [
  { key: "board", label: "交接对账" },
  { key: "payments", label: "收款流水" },
  { key: "prices", label: "油价与重算" },
  { key: "sync", label: "同步中心" }
] as const;

const active = ref<(typeof tabs)[number]["key"]>("board");
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 离线优先</p>
          <h1>加油站班次交接对账</h1>
          <p class="subtitle">
            交接单、油枪读数、收款流水三处合一，断网照常补录；网络恢复后合并两端记录，
            冲突留两版待站长核对，列表 / 汇总 / 导出共用同一对账状态与收入口径。
          </p>
        </div>
        <div class="top-actions">
          <span class="status" :class="store.online ? 'st-reviewed' : 'st-diff'">
            {{ store.online ? "在线" : "离线" }}
          </span>
          <button type="button" :disabled="!store.online || store.syncing" @click="store.syncNow()">
            同步<span v-if="store.pendingOps > 0">（{{ store.pendingOps }}）</span>
          </button>
        </div>
      </header>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          class="tab"
          :class="{ on: active === t.key }"
          @click="active = t.key"
        >
          {{ t.label }}
          <span v-if="t.key === 'sync' && store.pendingOps > 0" class="badge">{{ store.pendingOps }}</span>
          <span v-if="t.key === 'sync' && store.db.conflicts.length > 0" class="badge conflict">{{ store.db.conflicts.length }}</span>
        </button>
      </nav>

      <HandoverBoard v-if="active === 'board'" />
      <PaymentPanel v-else-if="active === 'payments'" />
      <PricePanel v-else-if="active === 'prices'" />
      <SyncPanel v-else />
    </div>
  </main>
</template>
