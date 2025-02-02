<template>
  <div class="flex-1 bg-gray-25 flex justify-center items-center window-drag">
    <!-- 0: Language Selection Slide -->
    <Slide
      @primary-clicked="handlePrimary"
      @secondary-clicked="handleSecondary"
      v-show="index === 0"
    >
      <template #title>
        {{ t`Select your language` }}
      </template>
      <template #content>
        <div class="flex flex-col justify-center items-center h-96">
          <LanguageSelector class="w-40 mt-8" :dont-reload="true" />
          <p
            class="text-sm mt-2 hover:underline cursor-pointer text-gray-700"
            @click="openContributingTranslations"
          >
            {{ t`I can't find my language.` }}
          </p>
        </div>
      </template>
      <template #secondaryButton>
        {{ t`Cancel` }}
      </template>
      <template #primaryButton>
        {{ t`Next` }}
      </template>
    </Slide>

    <!-- 1: Setup Wizard Slide -->
    <Slide
      :primary-disabled="!valuesFilled || loading"
      @primary-clicked="handlePrimary"
      @secondary-clicked="handleSecondary"
      v-show="index === 1"
    >
      <template #title>
        {{ t`Setup your organization` }}
      </template>

      <template #content>
        <div v-if="doc">
          <!-- Image Section -->
          <div class="flex items-center p-4 gap-4">
            <FormControl
              :df="getField('logo')"
              :value="doc.logo"
              @change="(value) => setValue('logo', value)"
            />
            <div>
              <FormControl
                ref="companyField"
                :df="getField('companyName')"
                :value="doc.companyName"
                @change="(value) => setValue('companyName', value)"
                input-class="
                  bg-transparent
                  font-semibold
                  text-xl
                "
                :autofocus="true"
              />
              <FormControl
                :df="getField('email')"
                :value="doc.email"
                @change="(value) => setValue('email', value)"
                input-class="
                  text-base
                  bg-transparent
                "
              />
            </div>
          </div>

          <p
            class="-mt-6 text-sm absolute text-red-400 w-full"
            style="left: 7.75rem"
            v-if="emailError"
          >
            {{ emailError }}
          </p>

          <TwoColumnForm :doc="doc" />
        </div>
      </template>
      <template #secondaryButton>{{ t`Back` }}</template>
      <template #primaryButton>{{ t`Submit` }}</template>
    </Slide>
  </div>
</template>

<script>
import FormControl from 'src/components/Controls/FormControl.vue';
import LanguageSelector from 'src/components/Controls/LanguageSelector.vue';
import TwoColumnForm from 'src/components/TwoColumnForm.vue';
import { fyo } from 'src/initFyo';
import { getErrorMessage } from 'src/utils';
import { openLink } from 'src/utils/ipcCalls';
import { getSetupWizardDoc } from 'src/utils/misc';
import { showMessageDialog } from 'src/utils/ui';
import Slide from './Slide.vue';

export default {
  name: 'SetupWizard',
  emits: ['setup-complete', 'setup-canceled'],
  data() {
    return {
      index: 0,
      doc: null,
      loading: false,
      valuesFilled: false,
      emailError: null,
    };
  },
  provide() {
    return {
      schemaName: 'SetupWizard',
      name: 'SetupWizard',
    };
  },
  components: {
    TwoColumnForm,
    FormControl,
    Slide,
    LanguageSelector,
  },
  async mounted() {
    if (fyo.config.get('language') !== undefined) {
      this.index = 1;
    }

    this.doc = await getSetupWizardDoc();
    this.doc.on('change', () => {
      this.valuesFilled = this.allValuesFilled();
    });
  },
  methods: {
    getField(fieldname) {
      return this.doc.schema?.fields.find((f) => f.fieldname === fieldname);
    },
    openContributingTranslations() {
      openLink(
        'https://github.com/frappe/books/wiki/Contributing-Translations'
      );
    },
    handlePrimary() {
      if (this.index === 0) {
        this.index = 1;
      } else if (this.index === 1) {
        this.submit();
      }
    },
    handleSecondary() {
      if (this.index === 1) {
        this.index = 0;
      } else if (this.index === 0) {
        this.$emit('setup-canceled');
      }
    },
    setValue(fieldname, value) {
      this.emailError = null;
      this.doc.set(fieldname, value).catch((e) => {
        if (fieldname === 'email') {
          this.emailError = getErrorMessage(e, this.doc);
        }
      });
    },
    allValuesFilled() {
      const values = this.doc.schema.fields
        .filter((f) => f.required)
        .map((f) => this.doc[f.fieldname]);
      return values.every(Boolean);
    },
    async submit() {
      if (!this.allValuesFilled()) {
        return await showMessageDialog({
          message: this.t`Please fill all values`,
        });
      }

      this.loading = true;
      this.$emit('setup-complete', this.doc.getValidDict());
    },
  },
  computed: {
    buttonText() {
      if (this.loading) {
        return this.t`Submit`;
      }

      return this.t`Setting Up...`;
    },
  },
};
</script>
