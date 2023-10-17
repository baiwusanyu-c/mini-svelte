<script>
  let counter = 0;
  const increment = () => counter++;
  const decrement = () => counter--;
</script>

<button on:click={decrement}>Decrement</button>
<div>{counter} x 2 = {counter * 2}</div>
<button on:click={increment}>Increment</button>
