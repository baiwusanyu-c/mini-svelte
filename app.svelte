<script>
  let counter = 0;
  const increment = () => counter++;
  const decrement = () => counter--;
</script>

<button on:click={decrement} id={"button_test"}>Decrement</button>
<div>{counter}</div>
<button on:click={increment}>Increment</button>
