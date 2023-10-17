
    export default function() {
      let button_1;
let txt_2;
let div_3;
let txt_4;
let txt_5;
let txt_6;
let button_7;
let txt_8;
      let counter = 0;
const increment = () => (counter++, lifecycle.update(['counter']));
const decrement = () => (counter--, lifecycle.update(['counter']));
      const lifecycle = {
        create(target) {
          button_1 = document.createElement('button');
button_1.addEventListener('click', decrement);
txt_2 = document.createTextNode('Decrement')
button_1.appendChild(txt_2)
target.appendChild(button_1)
div_3 = document.createElement('div');
txt_4 = document.createTextNode(counter)
div_3.appendChild(txt_4);
txt_5 = document.createTextNode(' x 2 = ')
div_3.appendChild(txt_5)
txt_6 = document.createTextNode(counter * 2)
div_3.appendChild(txt_6);
target.appendChild(div_3)
button_7 = document.createElement('button');
button_7.addEventListener('click', increment);
txt_8 = document.createTextNode('Increment')
button_7.appendChild(txt_8)
target.appendChild(button_7)
        },
        update(changed) {
          if (changed.includes('counter')) {
            txt_4.data = counter;
          }
if (changed.includes('counter')) {
            txt_6.data = counter * 2;
          }
        },
        destroy() {
          button_1.removeEventListener('click', decrement);
target.removeChild(button_1)
target.removeChild(div_3)
button_7.removeEventListener('click', increment);
target.removeChild(button_7)
        },
      };
      return lifecycle;
    }
  