<script setup lang="ts">
import { computed, ref } from "vue";
import { useShiftStore } from "../store/shiftStore";
import type { FuelType } from "../domain/types";
import { FUEL_TYPES } from "../domain/types";

const store = useShiftStore();

const fuelType = ref<FuelType>("92#汽油");
const price = ref<number | null>(null);

const history = computed(() =>
  [...store.db.prices].sort((a, b) => b.effectiveAt - a.effectiveAt)
);

function submit() {
  if (!(price.value && price.value > 0)) return;
  store.changePrice(fuelType.value, price.value);
  price.value = null;
}
</script>

<template>
  <section>
    <div class="metrics three">
      <article v-for="f in FUEL_TYPES" :key="f" class="metric">
        <span>{{ f }} 现价</span>
        <strong>¥{{ (store.pricesNow[f] ?? 0).toFixed(2) }}/L</strong>
      </article>
    </div>

    <form class="panel form-panel" @submit.prevent="submit">
      <h3>油价变更</h3>
      <div class="form-row">
        <label>油品
          <select v-model="fuelType"><option v-for="f in FUEL_TYPES" :key="f">{{ f }}</option></select>
        </label>
        <label>新单价（元/升）
          <input v-model.number="price" type="number" min="0.01" step="0.01" required placeholder="0.00" />
        </label>
        <button type="submit">生效并重算</button>
      </div>
      <p class="hint">变更后：未复核交接单的销售额按新价重算并进入待传队列；已复核交接单锁定不变。</p>
    </form>

    <table class="grid-table full">
      <thead><tr><th>生效时间</th><th>油品</th><th>单价（元/升）</th></tr></thead>
      <tbody>
        <tr v-for="(p, i) in history" :key="i">
          <td>{{ new Date(p.effectiveAt).toLocaleString("zh-CN", { hour12: false }) }}</td>
          <td>{{ p.fuelType }}</td>
          <td>{{ p.price.toFixed(2) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
